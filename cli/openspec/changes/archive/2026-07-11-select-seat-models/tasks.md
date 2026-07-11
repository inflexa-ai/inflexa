## 1. Config + resolution

- [x] 1.1 Add `models.seats` (`conversation?`, `sandbox?`) to the config schema (`lib/config.ts`),
      extending the block introduced by `configure-model-connection`
- [x] 1.2 Per-seat resolution in `modules/harness/config.ts`: `seats.<seat>` → `harness.model` →
      connection default; direct-mode "no resolvable model for a seat" boot error
- [x] 1.3 Unit tests: resolution order, both-seats fallback, absent-map equivalence with the
      single-model composition, direct-mode seat error

## 2. Per-seat composition

- [x] 2.1 Build one provider instance per distinct resolved seat model in `runtime.ts` (shared
      connection config, different bound models; a single instance when the seats coincide)
- [x] 2.2 Thread seat-specific provider+model through `run_deps.ts` (sandbox seat: step deps,
      execute-analysis incl. `synthesisModel`, ephemeral, target-assessment, data-profile bundle)
      and the conversation assembly (conversation seat) — use the research doc §5.4 seat table as
      the consumer checklist
- [x] 2.3 Prov emitters (`createBusArtifactRegistry`, `createRunProvenanceEmitter`) receive the
      sandbox seat's `{provider}/{model}` name
- [x] 2.4 Composition tests: distinct seats → distinct providers + correct per-seat stamping;
      coincident seats → one instance

## 3. Idleness gauge + live application

- [x] 3.1 Add the agent-work gauge to the runtime handle: in-flight analysis runs, data profiles,
      chat turns, ephemeral workflows (wired at the trigger surfaces the runtime already owns);
      indeterminate state reads as busy
- [x] 3.2 Pending-selection state + apply-at-idle: on settle of the last in-flight work,
      reconstruct the affected seat's provider and every closure over it (agent assembly, deps
      bundles, prov emitters with the new name); atomic swap so no request observes a mix
- [x] 3.3 Immediate-apply path when the gauge is idle at selection time
- [x] 3.4 Tests: busy switch defers and lands at settlement; idle switch applies immediately;
      in-flight work completes and records the old model; post-swap provenance carries the new
      name; grep-audit that no consumer holds a stale provider/emitter reference

## 4. Palette + picker + status

- [x] 4.1 Model-listing helper per connection mode (cliproxy `/models` reuse, uncached for the
      picker; direct `GET /models` / `/v1/models`) returning `Result`; failure → free-text mode
- [x] 4.2 Picker dialog (SelectDialog composition per the design gallery; PromptDialog free-text
      fallback) parameterized by seat, marking the seat's current model
- [x] 4.3 `Switch chat model` / `Switch sandbox model` palette commands (boot-gated like
      `analysis.reprofile`); selection writes `models.seats.<seat>` then hands to the
      apply/schedule path
- [x] 4.4 Extend the boot/status store with per-seat resolved models + pending selection; render
      in the status surface (consult the design gallery before adding the affordance; extend the
      gallery if a new block is needed)
- [x] 4.5 TUI tests (tmux-capture E2E per repo convention) for picker open→select→persist and the
      pending indicator
      (note: no runnable tmux E2E harness exists in the tree — the repo's concrete TUI test
      convention is the headless renderFrame/captureCharFrame harness used by every
      *.render.test.tsx, which these tests follow; a full-boot PTY E2E belongs to 5.2)

## 5. Verification

- [x] 5.1 `bun run typecheck`, `bun run lint`, `bun test` green in `cli/`
- [x] 5.2 End-to-end per the `verify` skill: distinct agent models on a cliproxy boot — chat turn
      on the conversation model, a profile/run step on the sandbox model, both recorded in the
      signed provenance document; a switch scheduled behind a run lands at settlement with the
      new name on subsequent events
      (settled by the user driving the live TUI: distinct models picked per agent via the palette,
      switches applied and scheduled during streaming, sidebar surfacing confirmed — "Ok, working
      well"; complemented by the mid-stream regression test and full automated coverage)

## 6. Rename: seats → agents

- [x] 6.1 Config surface: `models.seats` → `models.agents` (schema, `writeSeatModel` →
      `writeAgentModel`, resolution, JSDoc); the retired `seats` key is dropped without an alias
      (pre-release surface; zod strips the unknown key so a stale block is inert)
- [x] 6.2 Code vocabulary sweep: `SeatId`/`SEAT_IDS`/`SeatBackend`/`seat_switch.ts` and every
      `*Seat*` identifier → agent-based names that do NOT collide with harness catalog agent ids
      (verify by grep before choosing; e.g. `AgentName`/`AgentBackend`/`agent_switch.ts`); update
      all comments, notices, and test names; boot-error `model_required.seats` field renamed
- [x] 6.3 Full-suite green after the sweep (typecheck, lint, tests) with zero remaining `seat`
      identifiers in `cli/src` (comments included) outside quoted historical artifact text

## 7. Connection visibility in the TUI

- [x] 7.1 Thread the resolved connection identity (provider slug + mode) into the boot/status
      state beside the per-agent models
- [x] 7.2 Render it in the sidebar MODELS section (e.g. a connection line above the agent rows),
      per the existing section pattern; glyphs via `GLYPHS`, colors via theme roles
- [x] 7.3 Render tests for the connection line (cliproxy and direct variants)

## 8. Streaming-interruption defect (observed live in the TUI)

- [x] 8.1 Investigate: reproduce the reported behavior — switching a model while the agent is
      streaming a response appears to interrupt the response. Separate the CAUSE from adjacent
      machinery: candidate suspects include the palette/dialog interaction aborting the turn, the
      gauge reading idle during a streaming TUI turn (bracket not reached), the swap replacing the
      provider inner mid-stream, and the notice/sidebar re-render disturbing the stream blocks.
      Identify the root cause with file:line evidence BEFORE fixing
- [x] 8.2 Fix the root cause so the spec scenario "A chat turn defers the swap to the turn
      boundary, without disturbing the stream" holds in the live TUI
      (finding: the scenario already holds — no request-level defect; the deferral is fully wired
      through the TUI streaming path and proven by a mid-stream regression test. The perceived
      interruption is the modal overlay scrim dimming the app at 0.92 opacity while the picker is
      open — deliberate dialog UX, stream continues underneath and completes untruncated; whether
      to soften the scrim during streaming is a separate UX decision surfaced to the user)
- [x] 8.3 Regression test at the level the cause lives (turn engine / gauge / TUI hook), plus
      re-run of the full suite

## 9. Palette category

- [x] 9.1 Move `Switch chat model` / `Switch sandbox model` out of `View` into a new dedicated
      `Provider` command-palette category (extend `CommandCategory` + any category ordering the
      palette renders); update render/command tests
