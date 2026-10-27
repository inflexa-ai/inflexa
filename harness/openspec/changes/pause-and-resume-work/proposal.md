# Proposal

## Why

A failure that a person or time can repair ends the work today. A billing refusal of the host, a provider outage that outlives its retries, and a refused or missing credential fail a chat turn. A run and a data profile "suspend": they record the reason and cancel their own workflow. But no code resumes a suspended workflow (`DBOS.resumeWorkflow` has no caller), and under DBOS 5 a resume runs the same self-cancel again. Thus each suspension is terminal in practice.

This change lets the work wait in place until time or the user repairs the cause. It is PR 3 of the three stacked PRs of #570.

## What Changes

- A failure that a person or time can repair pauses the work. The work does not fail. The causes are these:
  - a provider outage after its retries
  - a `suspend` error, or a gate refusal with the suspend flag
  - a refused or missing credential
- A pause is a durable wait inside the workflow, not a cancel. The workflow stays active, and a recovery after a crash returns to the same wait. **BREAKING:** `cancelSelf` goes, and no work ends in the DBOS state `CANCELLED` for a suspension.
- The loop pauses at the failed model request, and it sends the request again after the resume. A gate refusal with the suspend flag pauses the work at the gate, and the gate runs again after the resume.
- A pause has two states. In `retrying`, the system sends the request again on a timer, up to a cap. In `paused`, the user owns the work. An outage starts in `retrying` and goes to `paused` at the cap. Each other cause goes to `paused` at once.
- Only a client resumes `paused` work. The server never resumes it by itself. A resume in `retrying` sends the request at once.
- Each waiting workflow writes a row in a new table `cortex_paused_work`, and a `data-pause` part in the stream of its work. A host lists the paused work of an analysis and resumes it through `CoreRuntime.pausedWork`.
- A recovered chat turn with no credential pauses with the cause `credential`. **BREAKING:** the failure code `interrupted` goes.
- A run with a paused step stays `running`. The other steps continue. **BREAKING:** the run status and the analysis status `suspended_insufficient_funds` go, with `suspendAnalysis`, `resumeAnalysis`, the topic `child-suspended`, and the outcome `suspended` of `RunCharge.close`. A migration moves the old rows to `failed` and to `active`.
- A refusal before the work starts (the authorization of a run or of a data profile) stays a refusal. It does not mark the analysis.
- **BREAKING:** the export `suspensionOfFailure` and the type `Suspension` go.
- DBOS runs with patching enabled. Thus it keeps one application version across upgrades, and a paused workflow recovers after an upgrade.

## Capabilities

### New Capabilities

- `work-pause`: the pause of durable work. It holds the causes, the durable wait, the two states, and the timer. It also holds the record and the part of a pause, the resume, and the stop.

### Modified Capabilities

- `workflow-suspension`: each requirement goes. `work-pause` replaces the capability.
- `workflow-failure-lifecycle`: a run has no suspended branch. A refused charge with the suspend flag pauses the run. A refused authorization with the suspend flag fails the run row.
- `data-profile-init`: the profile pauses in place, and a refused trigger does not mark the analysis.
- `chat-turn`: a turn reads its credential before each model request, and it pauses on a cause that a person or time can repair. The failure note and the failure codes lose the causes that now pause.
- `host-hooks`: a gate refusal with the suspend flag pauses the work.
- `sandbox-labels`: a refused spawn with the suspend flag pauses the caller.
- `artifact-manifest`: a refused registration with the suspend flag pauses the step.
- `plan-approval`: a `suspended` refusal of the launch fails the run row, and it does not mark the analysis.
- `run-state-persistence`: the run status `suspended_insufficient_funds` goes, and a migration moves the old rows.
- `cortex-state-layer`: the analysis status loses its suspended state, and a migration moves the old rows.
- `run-inspection`: a run with a paused step gives the state `paused`.
- `run-event-stream`: a run row has no suspended status to read.
- `run-cancellation`: no run is terminal as suspended.
- `run-synthesis-outcome`: a synthesis has no suspended outcome.
- `conversation-run-awareness`: no run is terminal as suspended.
- `analysis-summary-reads`: the terminal statuses lose `suspended_insufficient_funds`.
- `harness-durable-runtime`: the self-cancel is no longer a place that throws. DBOS launches with patching enabled.

## Impact

- Harness:
  - a new pause module in `workflows/`, which replaces `workflows/suspension.ts`
  - `loop/run-loop.ts`: the pause around each request series
  - `app/chat-turn-workflow.ts`, `app/chat-turn.ts`, and `loop/turn-credentials.ts`: the pause of a turn, the credential before each request, and the resume
  - `workflows/execute-analysis.ts`, `workflows/sandbox-step.ts`, and `tasks/data-profile.ts`: the pause in place, and the removal of the suspended branch
  - `tools/execute-analysis.ts`, `tools/research/inspect-run.ts`, `execution/run-canceler.ts`, `execution/run-event-stream.ts`, `billing/run-charge.ts`, and `state/`
  - `runtime/assemble.ts` and `index.ts`: the host surface `pausedWork`
- Migrations: the table `cortex_paused_work`, and the move of the old suspended rows of `cortex_runs` and `cortex_analysis_state`.
- CLI: a separate change, `connect-pause-and-resume`. The TUI shows a pause, and it resumes or stops the work.
- Cortex: a later PR in its own repository. It adapts to the removed run status, to the removed charge outcome, and to the new surface.
