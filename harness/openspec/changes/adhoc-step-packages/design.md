# Design

## Context

`buildAdHocPlan` (`src/tools/execute-analysis.ts:244-277`) writes one step
with no `packages` key. `AnalysisPlanSchema.parse` at line 276 adds none,
because the persistence schema keeps the field optional for old plans
(`src/schemas/workflow-state.ts:30-43`). `linkPlanPackages`
(`execute-analysis.ts:125-147`) makes a union of `step.packages ?? []`, and it
returns before the seam call when the union is empty. The refusal
`PlanPackagesMissingError` (lines 99-117) and the collision remedy (lines
179-187) are unreachable for an ad-hoc plan.

The router (`src/tools/ad-hoc-router.ts`) returns `agentId`, `resources`,
`rationale`, and `fallbackClass` (lines 25-36). Its prompt (lines 119-141)
imports `resourceEstimationSection` from `src/prompts/planner.ts`, and it
gets no package census. Its deps (lines 38-51) carry no inventory source.

The planner prompt teaches the package grammar in "The Packages of Each
Step" (`src/prompts/planner.ts:166-181`). That block is inline in
`plannerPrompt`. The one parser of the grammar is `parseQuery`
(`src/sandbox/package-identity.ts:204-241`), and the package-identity spec
forbids a second parser.

`queryPackages` (`src/tools/sandbox/list-available-packages.ts:373-466`) is
pure over its sections, and its `names` path resolves each entry with the same
ladder as the link. The read of the sections lives inside the `execute` of
the tool (lines 550-581). `ExecuteAnalysisToolDeps` (`execute-analysis.ts:49-64`)
carries none of `farmLockFile`, `imagePackagesFile`, or `readPoolInventory`.
The conversation agent passes the three to `generate_plan`
(`src/agents/conversation-agent.ts:297-308`) and not to `execute_analysis`
(lines 309-319).

The briefing withholds `packages` from the step agent (`src/prompts/briefing.ts:75-78`),
because the link pass consumes them. `caveats` is a task field that renders
as a `## Caveats` list (`briefing.ts:43-51`, `briefing.ts:123-125`).

## Goals / Non-Goals

**Goals:**

- An ad-hoc step carries a `packages` array, and the link pass runs on it
  with no change to the pass.
- One place teaches the grammar to the planner and to the router.
- A router guess never refuses a launch on its own. A name that the pool does
  not hold leaves the step with a caveat.
- A step with no packages says so to its agent.

**Non-Goals:**

- A CLI change. `inflexa run --plan` replays a plan file and has no ad-hoc
  path. The TUI chat calls the harness tool.
- A `packages` input on `execute_analysis`. The spec pins the input to `mode`
  plus one field, and an agent that omits the field lands in the behavior of
  today.
- The full package census in the router prompt. Issue #519 shows what a
  census invites, and the router runs under a 10-second deadline.
- A change to the link pass, the refusal text, or the collision remedy.

## Decisions

### D1. The router emits `packages`, validated on its own axis

`routeSchema` gains `packages: z.array(z.string()).optional()`. `AdHocRoute`
gains `packages: readonly string[]`, always present and possibly empty, and
`droppedPackages: readonly DroppedPackage[]`, where a `DroppedPackage` is
`{ entry: string; reason: "unparsable" | "absent" }`. The router passes each
entry through `parseQuery`. An entry that fails is dropped as `unparsable`,
and a non-string entry is dropped the same way, rendered with `String`. The
router keeps the first of two equal entries.
A package failure never sets `fallbackClass`, and the agent and the resources
validate as today. A missing `packages` field gives an empty array.

Alternative: a new `fallbackClass` member for a package failure. Rejected.
`fallbackClass` describes the route as a whole, and a caveat that says
"routing fallback" for a bad package entry misleads the step agent.

### D2. One exported section teaches the grammar

The block "The Packages of Each Step" moves out of `plannerPrompt` into an
exported `packagesSection()`. `plannerPrompt` calls it in the same place,
thus the planner text stays the same. The router imports it, the same as it
imports `resourceEstimationSection`. The router prompt adds one sentence: the
language of the selected specialist and the request text decide the track of
a name that both ecosystems hold.

The one bullet that names the package census keeps its meaning. The router
has no census, and it writes the prefixed form from its own knowledge of a
both-track name. A bare both-track name reaches the link pass, which refuses
with the two prefixed forms. The conversation agent then states the request
again with the track named, and the router passes that form through.

### D3. A targeted resolution, through an optional dep of the router

`AdHocRouterDeps` gains `resolvePackages?: (names: readonly string[]) =>
Promise<readonly CheckedPackage[] | null>`. `null` means that the inventory
is unavailable. The router calls it one time, after the parse, with the
entries that parsed. For each entry:

- one or more `present: true` hits: the entry stays as the model wrote it. A
  row matches an entry by its `requested` field, and a both-track name gives
  two rows.
- `present: false` with a `suggestion`: the spelling of the entry becomes the
  suggestion, and the track and the version stay. The pool holds that
  spelling, and the link pass would refuse the other one. Two entries that
  take one spelling become one entry, the same as two equal entries. The log
  record carries the final list, thus a rewrite is visible.
- `present: false` with no suggestion: the entry is dropped as `absent`.
- a `null` resolution, or no dep: every parsed entry stays, and the link pass
  judges.

A dropped `absent` entry is the decision of this design. The list of an ad-hoc
step is a guess of a model, and no person reviewed it. A refusal on a guess
blocks a run that the user asked for. A caveat tells the step agent the truth
before the first import, and the log record names the drop.

Alternative: keep the absent entry and let the link pass refuse with the
store-add remedy. Rejected for the reason above. A plan step keeps that path,
because a person approved the plan.

### D4. `execute_analysis` builds the resolver from the inventory deps

`ExecuteAnalysisToolDeps` gains the three optional fields of
`ListAvailablePackagesDeps`: `farmLockFile`, `imagePackagesFile`, and
`readPoolInventory`. The read of the sections moves out of the `execute` of
`list_available_packages` into an exported `readInventorySections(deps):
Promise<InventoryRead>`, and the tool calls it. An `InventoryRead` is
`{ kind: "sections"; sections }` or `{ kind: "unavailable"; reason? }`. The
read keeps the reason, because the `available: false` note of the tool gives
the reason of the pool to the model.

`persistedAdHocPlan` builds `resolvePackages` from that read when at least one
of the three deps is bound: read the sections, and answer
`queryPackages(sections, { names }).checked`, or `null` when the read is
`unavailable`. Without a bound dep the router gets no
resolver. The default paths name a container mount, and a read of them on a
host is a wasted stat. The conversation agent passes the three deps to the tool, the same as
it does for `generate_plan`.

Alternative: build a `list_available_packages` tool instance inside the
launch path and call its `execute`. Rejected. The tool answers a model, and it
renders text. The launch path needs the checked rows only.

### D5. `buildAdHocPlan` writes the packages and the caveats

The step gets `packages: route.packages`. The caveats compose in this order:

1. The routing fallback, as today.
2. One caveat that names each dropped entry with its reason.
3. One caveat when `packages` is empty. It says that the step declares no
   packages, and that the link pass linked nothing. It tells the agent to
   confirm each import before it uses it.

The field stays `undefined` when no caveat applies.

### D6. The link pass reports its count

`linkPlanPackages` returns the number of queries that it sent to the seam.
It returns zero when the seam is unbound or the union is empty. The
`analysis launched` record gains `packageQueries` with that number.

### D7. The briefing comment holds for every step

The comment at `src/prompts/briefing.ts:75-78` states that the link pass
consumes the packages of a step. After this change that is true for an
ad-hoc step too. The comment says so, and the field stays withheld.

## Risks / Trade-offs

- [A both-track bare name refuses a consented run] → The refusal names the two
  prefixed forms. The conversation agent states the request again with the
  track, and the router keeps a prefixed form from the request. That is the
  plan-mode path.
- [The router prompt grows] → The section is about fifteen lines. The
  10-second deadline still holds, and a timeout gives the deterministic
  fallback with an empty package list and the caveat.
- [A dropped absent name hides a store-add remedy] → The caveat and the log
  name the drop. In the CLI the step agent holds `link_packages`, and the
  tool answers with the remedy.
- [Cortex and the CLI differ] → Cortex binds the seam on the conversation
  agent only, and it links nothing. The tests bind a seam in the tool tests,
  thus a green CLI does not prove Cortex. The design changes no seam contract.
- [`readInventorySections` moves code that the catalog tests cover] → The
  tool keeps its behavior, and the existing tests of the tool run after the
  move.
