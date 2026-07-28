## Context

The CLI currently imports `sweepEphemeralWorkflows`, exposes it as a boot seam, and calls it before DBOS launch because the retired `runEphemeral` workflow was tied to a dead chat turn and could not be recovered safely. The replacement `runAdhoc` workflow is a normal durable run and must be eligible for standard DBOS recovery. The harness release also replaces the workflow dependency and resource-policy fields the CLI supplies.

## Goals / Non-Goals

**Goals:**

- Remove every CLI-owned ephemeral cancellation path.
- Adopt the harness's `runAdhoc` workflow dependency and `ResourcePolicy.adhoc` surface.
- Preserve the remaining `beforeLaunch` duties and their ordering.
- Keep adhoc run rendering on the existing run/step ledger path.

**Non-Goals:**

- Add a distinct adhoc UI or sidebar query.
- Change DBOS recovery policy for planned runs, profiles, or sandbox hygiene.
- Preserve the retired `ephemeral` config key as a compatibility alias.

## Decisions

**D1 — Delete the sweep seam rather than retaining a no-op.** The harness no longer exports the sweep and adhoc workflows must recover normally. Keeping a CLI shim would preserve dead vocabulary and an ordering assertion for work that no longer exists.

**D2 — Wire `runAdhoc` through the existing core runtime assembly.** The CLI supplies the local pool and run authorizer; `assembleCoreRuntime` supplies the already-registered sandbox-step callable and shared resource policy. A CLI-owned workflow registration would duplicate the harness composition boundary.

**D3 — Rename configuration directly to `adhoc`.** The resolved CLI schema and emitted `ResourcePolicy` use the harness-owned term. No compatibility alias is retained because the old field configured a retired behavior and the harness API change is already breaking.

**D4 — Leave the sidebar untouched.** Adhoc runs write ordinary `cortex_runs` and `cortex_step_executions` rows, which the existing polling path already displays. A separate UI branch would redefine a harness-owned run concept in the embedder.

## Risks / Trade-offs

- [Existing local config uses `resourceLimits.ephemeral`] → Validation reports the stale key through the CLI's existing config-error path; the user renames it to `adhoc`.
- [Removing one pre-launch action changes boot-order tests] → Keep assertions for ask expiry, agent-switch installation, and sandbox-hygiene registration, and delete only the sweep event.
- [Harness API versions can drift during development] → Apply this change with the harness version that exports `runAdhoc` and omits the ephemeral surface; typecheck pins the integration.
