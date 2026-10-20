# Proposal

## Why

GitHub issue #686: an approval refuses a second run only while a run of the plan is active (`src/tools/execute-analysis.ts:594-596`). A person can run one plan many times, thus that rule is correct for a deliberate run again. But it does not stop a duplicate approval from a stale view.

Window A and window B show the same plan card. Window A reads the plan, and the plan has no run. Window B approves the plan, and its run starts and ends. Then the approval of window A arrives. No run is active, thus the launch starts a second run that the person did not ask for. A client cannot close the gap between its read and its post.

The cli connects the check in a companion change with the same name.

## What Changes

- **BREAKING** `ApprovePlanInput` gets the required member `newestRunId: string | null`. It is the newest run of the plan in the view that the person approved, or `null` when that view showed no run.
- `launchPlanRun` takes an optional `newestRunId`. With it, the launch starts a run only when the newest run of the plan is that run. For `null`, the plan must have no run. The launch reads the newest run before the link pass, and it reads it again in the transaction that reserves the run. Without it, the launch behaves as it does now.
- Each reservation of a stored plan holds a lock of the plan, also a reservation of the tool. Its new row gets a start time after the newest start of the plan. Thus the new row is always the newest run.
- A launch whose newest run is a different run starts nothing. It gives the newest run with `started: false`, the same as for an active run.
- A launch that names a run while the plan has no run starts nothing. It gives the new refusal `run_not_found` with the run id.
- `approvePlan` passes its `newestRunId` to the launch. `started: false` now also means that the view of the person was stale.
- The plan mode of `execute_analysis` gives no `newestRunId`. Thus the agent can still run a plan again when the person asks.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `plan-approval`: the launch of a stored plan compares the newest run of the plan with the run that the caller saw. The approval gives that run to the launch.

## Impact

- Harness code: `src/tools/execute-analysis.ts`, `src/app/approve-plan.ts`, `src/state/runs.ts`, and their tests. The barrel test of the approval and the runtime test give the new input member.
- Database: no migration. The newest-run read uses the index `idx_cortex_runs_plan` on `(analysis_id, plan_id, started_at DESC, run_id DESC)`.
- Embedders: an embedder that calls `approvePlan` must give `newestRunId`. A host that switches over `ApprovePlanRefusal` or `LaunchPlanRunRefusal` exhaustively must add a case for `run_not_found`. The cli does both in its companion change.
