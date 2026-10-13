# Design

## Context

The harness change `align-run-stream-and-outputs-with-contracts`
(`harness/openspec/changes/align-run-stream-and-outputs-with-contracts/design.md`)
holds the decisions. See its D3 for the terminal status
`suspended_insufficient_funds`, and its D5 for the split of the two changes.

## Goals / Non-Goals

**Goals:**

- The cli treats `suspended_insufficient_funds` as a terminal run status in each
  reader: the live-work count, the sidebar, the run completion notice, and
  `run --plan`.

**Non-Goals:**

- No new cli surface. The run completion notice and the run card already have a
  tone and a text for the status.

## Decisions

### D1. The live-work count reads `running` only

`RUN_IS_LIVE` (`src/server/durable_work.ts`) counts a run when its row reads
`running` and a live workflow stands behind it. A suspended run is terminal. Its
parent workflow is `CANCELLED`, thus it never counted in practice.

### D2. The sidebar arms its fast poll for `running` only

`RUN_STATUS_TERMINAL` (`src/tui/hooks/sidebar_live.ts`) marks the status
terminal. As a result the run completion notice announces a suspended run with
its existing text "was suspended (insufficient funds)".

### D3. `run --plan` names the next action

The outcome message of a suspended run says that the host suspended the run and
that a new run of the plan can start. It does not promise a resume.

## Risks / Trade-offs

- [The cli typecheck reads `ProvRunOutcome` from the npm `prov-kernel`] → During
  development run `bun run kernel:local`, as CI does.
