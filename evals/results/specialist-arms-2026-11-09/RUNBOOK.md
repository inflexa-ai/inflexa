# Runbook: the three arms of the step agents

## The arms

| Arm | Flag | What runs |
| --- | --- | --- |
| A, production | none | The current specialists. |
| B, stance | `--sandbox-arm stance` | Five specialists (`evals/arms/stance/`), and the executor for each other agent. |
| C, one agent | `--sandbox-arm one` | One agent (`evals/arms/one/analyst.md`) with each skill and each tool. |

Each variant holds the union of the skills and the tools of the agents that it
replaces (`evals/lib/sandbox-arms.ts`). Only the prompt body and the split
change. A case keeps its id in each arm, thus `compare` pairs the reports.

## The cases

- The domain cases (`evals/cases/domain.ts`): one behavior for each method choice
  that a stance drives, a dev case and a held-out twin, graded on the scripts.
- The step cases (`evals/cases/sandbox.ts`): the shared standards. They are the
  regression set. Both arms hold every tool that these cases script.

Select the domain cases:

```bash
cd evals
DEV=$(grep -o 'id: "domain-[^"]*"' cases/domain.ts | cut -d'"' -f2 | grep -v held-out | sed 's/^/--case /' | tr '\n' ' ')
HELD=$(grep -o 'id: "domain-[^"]*-held-out"' cases/domain.ts | cut -d'"' -f2 | sed 's/^/--case /' | tr '\n' ' ')
```

## Real execution (`--exec docker`)

Each command of a sandbox case runs in a container of the production image
(`ghcr.io/inflexa-ai/sandbox-base:20261029-c94d23e`, `EVALS_SANDBOX_IMAGE`),
with no network, as the sandbox user, with 2 CPU and 8 GB. The mounts and the
environment are `buildMountPlan` of the harness. Each trial gets its own farm,
composed from the package store as the CLI composes it, and `link_packages`
links into it for real. A case with `generate` gets real binary inputs (AnnData,
FCS, VCF), cached in `tmp/evals/fixtures/`. The report records the mode and the
image under `exec`.

Use real execution for each arm comparison. The scripted sandbox cannot satisfy a
model that checks its own output: Qwen probed it until the step cap.

A crash can leave a container (`docker ps -a --filter name=inflexa-eval`) or a
farm (`<store>/farms/eval-*`). Remove them by hand when no run is active.

## Prerequisites

- `cli/node_modules/@inflexa-ai/harness` links the working copy. Done on
  2026-11-09 with `bun run harness:local` in `cli/`. Do it again after a pull.
- The CLI model proxy runs for a Sonnet or Opus run. It stops with OrbStack.
- An `hc` terminal does not get the env of the session. Start each run as
  `zsh -c 'set -a; . ./.env.local; set +a; bun run evals run ...'`. `evals/.env.local`
  holds `OPENROUTER_API_KEY`.
- Qwen: `--provider ../tmp/claude/specialists/qwen.provider.json` (`qwen/qwen3.8-27b`).
- Docker runs, and the image is local. Use `--concurrency 3` (the VM has 16 GB).

## Phase 0: validate the cases (before any arm comparison)

New cases have defects first. Run arm A only:

```bash
bun run evals run $DEV --exec docker --trials 2 --concurrency 3 --out ../tmp/claude/specialists/runs/p0-sonnet-A-dev.json
bun run evals run $DEV --exec docker --trials 1 --concurrency 3 --model claude-opus-5-5 --out ../tmp/claude/specialists/runs/p0-opus-A-dev.json
```

Read each failed trial. A case that Opus fails is a case defect first
(`evals/CLAUDE.md`, "Design a case"). Fix the case, not the prompt. Then do the
same for the held-out set.

## Phase 1: Sonnet, three arms

```bash
for ARM in A stance one; do
  FLAG=$([ "$ARM" = A ] || echo "--sandbox-arm $ARM")
  bun run evals run $DEV $FLAG --exec docker --trials 3 --concurrency 3 --out ../tmp/claude/specialists/runs/p1-sonnet-$ARM-dev.json
  bun run evals run $HELD $FLAG --exec docker --trials 3 --concurrency 3 --out ../tmp/claude/specialists/runs/p1-sonnet-$ARM-held.json
done
bun run evals compare ../tmp/claude/specialists/runs/p1-sonnet-A-dev.json ../tmp/claude/specialists/runs/p1-sonnet-one-dev.json
```

## Phase 2: Qwen, three arms

The same loop, with `--provider ../tmp/claude/specialists/qwen.provider.json
--trials 2`. A Qwen step takes about 2 minutes. GLM is the tier where a difference shows: Sonnet
passed nearly each earlier case.

## Phase 3: the regression set

The step cases of `sandbox.ts` on arms B and C, Sonnet, 3 trials, against a
fresh arm-A baseline of the same commit:

```bash
bun run evals run --set dev $FLAG --trials 3 --case <each step case id>
```

## How to decide

- For each domain group (matrix, cells, interpretation, modeling, genetics),
  compare arm C with arm B on both models, dev and held-out.
- Arm C wins a group when it is not worse on either model and costs less.
  Then the group folds.
- Arm B wins a group when arm C is worse on dev and on held-out. Then the
  group keeps a stance: a specialist, or a selected stance section.
- A difference of one trial is noise (`evals/CLAUDE.md`).

## The cost

A step trial costs about 150k to 500k input tokens, most of them cache reads. A domain case allows 40 steps and 1 hour. Phase 1 is 26 cases x
3 trials x 3 arms, about 234 trials, thus about 35 to 47 M tokens. Phase 0
is about 40 trials.

## The bench

Blocked. The bench host pins harness 0.46.2 (`bench/host/package.json:42`)
and calls `registerSandboxReaper` (`bench/host/src/compose/boot_host.ts:25`).
Harness 0.47 removed that API with the sandbox leases. Thus the host cannot
boot the working copy until the host moves to the lease API.

After that port:

- The climb set has six bulk RNA-seq tasks. Its plans use only the bulk and the
  enrichment agents, thus it measures the matrix and the interpretation groups.
- The planner catalog is a module constant (`harness/src/agents/sandbox-catalog.ts`).
  Thus arms B and C need one harness build each, with the catalog and the
  bodies of the arm.
- A climb session compares two sides on one seed. Seed noise was larger than
  the prompt effects in past climbs. Read `bench-map.md` for the commands.
