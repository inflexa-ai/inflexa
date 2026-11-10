# Bench map for the three-arm specialist comparison

Read-only investigation of `/Users/rkrajla/code/inflexa-ai/bench` (main, `90327fd`) on 2026-11-09.
Paths without a prefix are in the bench repo. `harness/…` and `cli/…` are in the inflexa monorepo.

## 0. Blocker first

The bench host cannot boot the current harness working copy.

- The host is pinned to `@inflexa-ai/harness` 0.46.2 (`host/package.json:42`). The working copy is 0.48.9 (`harness/package.json:3`).
- Harness 0.47.0 (commit `76b97614`, "hold each sandbox through a lease") removed `registerSandboxReaper` and changed `SandboxAgentBuildContext` to carry `lease` instead of `sandbox`/`deadlineMs` (`harness/src/workflows/sandbox-step.ts:210-234`).
- The host still imports `registerSandboxReaper` (`host/src/compose/boot_host.ts:25`, `:408`, `:982`) and reads `ctx.sandbox` and `ctx.deadlineMs` (`boot_host.ts:880`, `:884`). The host also does not pass the new `CoreSandboxDeps` (`harness/src/runtime/assemble.ts:93-98`).
- `harness:local` builds and links the checkout but does not typecheck the host (`host/package.json:19`). So a linked 0.48.9 fails at boot or in the first step (`boot_threw` / `harness_threw`), not at install.
- The current link in `host/node_modules/@inflexa-ai/harness` points at `.claude/worktrees/harness-context-fixes/harness` (0.46.2). No bench branch ports the host to the lease API (branches: `main`, `host-harness-046`, `climb-gate-fixes`, `feat/hill-climb-tiers`).

So step zero of any arm comparison on the current harness: port `host/src/compose/boot_host.ts` to the lease API (≥0.47), and bump the pin/parity record. Without it the arms must be built on a 0.46.2 base.

## 1. "Short tier"

There is no tier named `short` in the plan or the code. The plan tiers are `smoke`, `core`, `full`, `flagship` (`docs/bench-plan/07-operations.md:535-551`).

"Short" is tier 3 of the hill-climb ladder in a research note, not the plan (`docs/research/hill-climb-tiers.md:25-33`):

- Tier 3 "Short": one sandbox step end to end on `two-group-n6-de` and `no-replicates-stop`, both flows, 4 rollouts, about 1 hour, about 12 M input tokens. It detects a broken path (no run, no file, no answer, failed stop) (`hill-climb-tiers.md:31`).
- Tier 4 "Smoke": 5 simulated smoke tasks × 2 flows × 1 trial, about 2.5 h, 30 M tokens (`:32`).

What the plan implemented is `bench climb`, with a "climb set" of six core tasks (`07-operations.md:1079-1090`):
`two-group-n6-de`, `batch-confounded-stop`, `no-replicates-stop`, `normalization-de`, `low-count-filter-de`, `thinned-enrichment-universe-sets`.

Modalities: all bulk RNA-seq (DE, two stop tasks, enrichment on thinned GTEx). Only `bulk-rnaseq-sim` and `bulk-rnaseq-thinned` have a `climb` seed range (`tasks/families/bulk-rnaseq-sim/calibration.yaml:64`, `tasks/families/bulk-rnaseq-thinned/calibration.yaml:51`). A task of any other family is refused with `climb_range_absent` (`src/cli/climb.ts:776`). The single-cell `scbench-canonical` and the `genebench-pro` tasks are `tier: [smoke]` only and cannot run in a climb.

Agents that these tasks hit: from every `plan.json` under `results/climb/`, the planner used only `bulk-transcriptomics-agent` and `enrichment-agent` (for example `two-group-n6-de`: 40 and 19 steps). So the climb set exercises two of the specialists, not five.

Cost/time:

- Plan guess: host rollout 12-30 min, side of six tasks 1.5-3 h on one slot, about 30 min on six slots, 15-30 USD a side (`07-operations.md:1087-1090`). Task caps: 1800 s and 5 USD (`tasks/families/bulk-rnaseq-sim/tasks.yaml:159-161`).
- Measured on disk (Sonnet 5.5, planned flow, after the effort fix `d7f1187`): median per rollout: analysis tasks about 0.94-1.05 USD and 5.5-6.5 min, stop tasks about 0.15 USD and 1 min. A side of six tasks on two slots: 2.2-4.9 USD, longest rollout 3.4-10 min (`results/climb/*/summary.json`). Before the effort fix a side cost about 20 USD and hit the 30 min clock.

## 2. How the bench selects the harness

- Campaigns use the npm pin in `host/package.json:42` only. The readiness gate (item 1) refuses a link (`docs/bench-plan/03-repository.md:42-44`).
- `bench host` and `bench climb` run under a local link and are labeled exploratory (`03-repository.md:32-44`).
- The link: in `host/`, `HARNESS_DIR=<checkout>/harness bun run harness:local`. It removes the installed harness, runs `bun install --frozen-lockfile` and `bun run build` in the checkout, and symlinks it (`host/package.json:19`). The default is `../../inflexa/harness`. `bun run harness:remote` restores the pin (`host/package.json:20`).
- `composition.example.json` is not a harness selector. It holds the endpoints, models, stores, Postgres, and engine of one slot.
- The image in the composition is the sandbox image, not a harness image (`composition.example.json` `stores.image`).
- The card and the climb summary record the link: commit, dirty flag, diff digest, and `dist/` digest (`07-operations.md:1020-1034`, `boot_host.ts` card block, `results/climb/*/summary.json` `sides.*.harness`).

To run against a local harness: (0) port the host (section 0), then link the arm checkout with `HARNESS_DIR`, then run `bench climb`. Each side is one link. Do not edit or rebuild the linked checkout during a side: a different `dist/` digest at the after-read makes the side invalid (`07-operations.md:1029-1034`).

## 3. Knobs for prompt, catalog, or one-agent routing

None exist in the bench or the harness.

- The harness reads no environment variable except `OTEL_EXPORTER_OTLP_ENDPOINT` (`boot_host.ts` comment at `initTelemetry`, and `grep process.env harness/src` gives test files only).
- The step-agent catalog is module-level: `SANDBOX_AGENT_META` and `createSandboxAgents` (`harness/src/agents/sandbox/index.ts:53-107`). The planner catalog is derived at import (`harness/src/agents/sandbox-catalog.ts:60-112`) and is used by the following:
  - The planner prompt (`harness/src/tools/research/generate-plan.ts:240`).
  - The plan `z.enum` (`harness/src/schemas/plan-schemas.ts:9`).
  - Plan validation (`harness/src/schemas/validate-plan.ts:16-24`).
  - The ad hoc router of the `direct` flow (`harness/src/tools/ad-hoc-router.ts:207`, `:279-280`), with fallback `scientific-executor` (`:28`).
- The embedder supplies `buildAgent` (`boot_host.ts:861-896`, `cli/src/modules/harness/run_deps.ts:190`). It could ignore `ctx.input.agentId`, but it can only pick from `createSandboxAgents(deps)`. `createSandboxAgent` and the prompt modules are not exported from the package root (`harness/src/index.ts:767` exports only `createSandboxAgents, SANDBOX_AGENT_META`), and the bench can import only the root (`CLAUDE.md`, "An import of `@inflexa-ai/harness` reads the package root"). It also cannot change the planner catalog. An embedder-side override would also break the rule that an embedder does not control what the harness does (inflexa `CLAUDE.md`).
- The parity proof lists `agentSwitch` as a CLI-only row with host `none` (`host/src/parity/cli-composition.json:51`). That is the CLI's live model switch, not an agent catalog.
- Arm C has a ready agent: `scientific-executor` already declares every skill (`harness/src/agents/sandbox/scientific-executor.ts:11-48`), but it is `plannable: false` and has fewer tools than some specialists (`:45-46`).

The smallest path needs no knob. Each arm is its own harness build:

- Arm A: the base commit.
- Arm B: the base, plus the five prompt bodies and the catalog meta.
- Arm C: the base, plus a catalog that holds only the generic agent (plannable) for the planner, the plan schema, and the ad hoc router.

 The bench already records each build by commit and `dist/` digest. If a permanent knob is wanted later, put it in the harness: one option on `CoreRuntimeDeps` that gives the sandbox catalog to the planner, the router, the plan schema, and `createSandboxAgents`. The catalog would then be a value, not a module constant. The bench host would then pass it from the composition. That is a harness refactor, not a small change, because `PLANNABLE_AGENT_IDS` feeds a `z.enum` at import.

## 4. Results and comparison

- `bench climb` writes `results/climb/<session>/` with `session.json`, `baseline/<task>/`, `candidate/<task>/`, optional `control/<task>/`, and `summary.json` (`07-operations.md:920-937`).
- Each rollout's `climb.json` holds the following (`07-operations.md:939-951`, file keys `lane, task, status, stop_reason, bench_fault, harness_fault, cost_usd, wall_clock_ms, turns, tool_calls, grade{passed, measures}, flags, error`):
  - The pass, and the raw grader measures (recall, FDR, counts, claims checked/wrong).
  - The cost in USD, the wall-clock time, and the turns.
  - The flags and the fault kind.
- Tokens are not in `climb.json`. Each rollout directory has `usage.jsonl` with `agentId` and input/output/cache tokens per call, and `proxy.jsonl` per proxied call. A per-agent cost/token split comes from `usage.jsonl`. The prior climb used `inflexa/tmp/claude/climb/analyze.py <session>/<side>` for this.
- `summary.json` gives per task `held` / `dropped` / `gained` / `failed` / `unscored` / `pending`, the harness of each side, and a gate (`07-operations.md:1003-1063`). Exit 0 = ran and gate passed/pending, 3 = gate failed, 1 = other failure, 2 = usage (`:1058-1063`).
- A climb gives no rate, interval, or verdict (`07-operations.md:1065-1077`). `bench compare` reads campaigns only (`:1071-1074`). Its paired bootstrap, `improved`/`regressed`/`noise`, and cost and time rows are campaign tools (`:773-830`).
- `judges/` is the L4 model judge of campaigns. It enters no score (README "The construct"). It is not used by a climb.

Limit for three arms: a session has exactly two sides (`src/cli/climb.ts:64`), one seed, and one trial a task. Three arms need two sessions (A vs B, A vs C), each on its own seed. No command compares across sessions. The prior climb found that the seed noise of the answer format was larger than the prompt effects: the same harness passed 3, 5, 3, 4, 4 of 6 across seeds (`inflexa/tmp/claude/climb/LEDGER.md`, "Final measure").

## 5. Command sequence for one arm pair

Prerequisites, from the plan (`03-repository.md:209-223`) and the last working setup (`inflexa/tmp/claude/climb/composition-1.json`, `LEDGER.md`):

- Bun at `.bun-version`, Node 24. Run `bun install` in the bench root and in `host/`. The root install is necessary for `host/` (`CLAUDE.md` Quick Start).
- Docker or podman with the sandbox image present. The last setup used OrbStack (`sandboxEngine.socketPath: ~/.orbstack/run/docker.sock`) and image `ghcr.io/inflexa-ai/sandbox-base:20261006-cdbff09`.
- Postgres with pgvector, one database and one admin port per slot. The operator makes the databases (`07-operations.md:909-913`). The last setup used port 8434, `bench_climb_1` and `bench_climb_2`, and admin ports 3011+.
- The model endpoint in `connection.baseURL`. The last setup used the CLI model proxy on `127.0.0.1:8318`. A memory note says that this proxy dies with OrbStack. The bench starts its own proxy in front with no ceiling (`07-operations.md:915-918`). It fetches the Bifrost datasheet for prices, so network access is necessary (`src/cli/host.ts:95-99`).
- The embedding endpoint: `bun scripts/embedding_server.ts` (default port 8318, so set `--port`, for example 8320) (`scripts/embedding_server.ts:1-14`).
- The package store, the farm, the refs, and a skills tree. `stores.skillsDir` is part of the session digest. All arms must use one skills path, or the second side is refused with `session_mismatch: composition.stores` (`src/cli/climb.ts:636-668`).
- The model is the same for every role (`07-operations.md:896-898`).

Sequence (from `inflexa/tmp/claude/climb/s1-baseline.log`, adapted):

```bash
cd ~/code/inflexa-ai/bench/host
HARNESS_DIR=<arm-A checkout>/harness bun run harness:local
cd ..
bun scripts/bench.ts climb --side baseline --flow planned --model claude-sonnet-5-5 \
  --tasks two-group-n6-de,batch-confounded-stop,no-replicates-stop,normalization-de,low-count-filter-de,thinned-enrichment-universe-sets \
  --composition <comp-1.json> --composition <comp-2.json> --engine docker
# prints results/climb/<session>/summary.json
cd host && HARNESS_DIR=<arm-B checkout>/harness bun run harness:local && cd ..
bun scripts/bench.ts climb --side candidate --session <session> \
  --composition <comp-1.json> --composition <comp-2.json>
```

Use `--tasks two-group-n6-de,no-replicates-stop` and both `--flow planned` and `--flow direct` for the hill-climb "short" tier 3. Each flow is its own session. `--control raw-model` adds a floor lane in the opening call (`07-operations.md:896-902`). `CLAUDE.md` ("The cost of a run") says to give the duration before a long command. A climb is not a campaign "block", so it does not need the window rule.

## 6. Prior discussion of variants

- `docs/research/hill-climb-tiers.md` covers the general topic: prompt cuts, rules moved to code, and "a classifier of the sub-agent route" (`:3-7`, `:133-139`). The loop can edit prompts and tool descriptions, but not the skills tree (`:135-136`). The note proposes digests of the prompts on the card (`:56`, `:149`), and these do not exist. The card has no prompt digest, so an arm differs on the card only by commit and `dist/` digest.
- The release factor `[prompt]` lets `bench compare` compare two releases with different system prompts without `not_locked` (`docs/research/directions.md` D-187, `07-operations.md:786`, `:796-797`). That is the campaign route for a published arm.
- The vision's "flow question" compares host flows, not agent catalogs (`docs/bench-plan/01-vision.md`, README "The bench answers four questions").
- Nothing in `docs/bench-plan` or `docs/research` discusses specialist versus generic step agents.
