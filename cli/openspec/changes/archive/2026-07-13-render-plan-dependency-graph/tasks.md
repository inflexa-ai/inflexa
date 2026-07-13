# Tasks — plan dependency graph (CLI)

## 1. Spec

- [x] `openspec validate render-plan-dependency-graph --strict` passes
- [x] Review before implementation

## 2. Renderer (`src/modules/harness/plan_dag.ts`)

- [x] Pure `planToDag(steps, opts)` → ASCII string: longest-path levels, one box
      per step, `depends_on` edges via the direction-bitmask connector band
- [x] Junction resolver: U/D/L/R bits → box-drawing glyph; per-parent
      directional segments (straight single-parent, crisp multi-parent merge)
- [x] Interior padding + connector gap row; label truncation (~24 chars, `…`)
- [x] Defensive level computation (unknown `depends_on` skipped; back-edge → 0)
- [x] Unit tests: linear, branching (merge), wide fan-out, cycle guard,
      unknown-dep skip; assert glyphs + dimensions on golden strings

## 3. Card data (`readPlanCard`, `PlanCardStepView`)

- [x] `readPlanCard` extracts `depends_on` + detail fields (`question`,
      `acceptance_criteria`, `constraints`, `caveats`, `resources`, `track`,
      `step_type`) as primitives, copy-on-receive
- [x] `PlanCardStepView` (in `src/types/session.ts`) gains the carried fields
- [x] Reader tests: fields extracted and deep-copied; missing/mistyped coerced,
      never thrown

## 4. Plan-card block (`tui-stream-blocks`)

- [x] `PlanCardBlock` renders the graph via `planToDag` into a `<text>`;
      horizontal scroll for over-wide graphs
- [x] Fallback to the flat step list on empty `steps` or a `Result` render error
- [x] Design-gallery exhibits: linear, branching, wide, long-label, and the
      empty/fallback state
- [x] Layout tests (`testRender`) across widths (80 / 100 / 120) — sweep, since
      the overlap bugs are size-dependent

## 5. Step detail + explore command (`command-palette`)

- [x] Step-detail dialog: `question`, `acceptance_criteria`, `constraints`,
      `caveats`, `resources`, `agent`, `depends_on`
- [x] "Explore plan steps…" command: `SelectDialog` over the latest plan's
      steps → step-detail dialog; `enabled(ctx)` false when no plan in transcript
- [x] Command id remappable via `config.keybinds`
- [x] Design-gallery exhibit of the step-detail dialog; dialog showcase entry

## 6. REPL parity (`chat-command`)

- [x] `chat_printer.ts` prints the plan via `planToDag` (plain text) instead of
      per-step lines; same fallback on empty/error
- [x] Printer test: dependency graph text emitted for a branching plan

## 7. Close-out

- [x] `bun run typecheck`, `bun run lint`, `bun test` green
- [x] `bun run format:file` on every touched `src/` file
- [x] Verify end-to-end: a real plan card renders the status-free graph; a step opens
      its detail; live execution status remains solely in the sticky `RunProgressRow`
