# Design — stamp-opaque-sandbox-pod-labels

## Context

`ResolveBilling` gives the final wire headers, not the raw attribution map. The
managed realization assembles a gateway header set, where the key
`X-Inflexa-Billing-Context` arrives as `x-bf-lh-billing-context`. The two spawn
sites read the raw key, thus each read gives `undefined` and each pod spawns with
no label. A reconciler that filters on a non-empty billing-context pod label sees
no allocation at all.

## Goals / Non-Goals

**Goals:**

- A sandbox pod carries the attribution labels that the host asks for.
- The harness holds no billing vocabulary at the sandbox boundary.
- No change to the DBOS step sequence, thus an in-flight workflow replays cleanly
  across the deploy.

**Non-Goals:**

- The `ResolveBilling` seam, the providers, and the LLM/embedding attribution.
  They keep their own resolver, and this change does not touch them.
- The Docker backend. A local container has no cost reconciler.

## Decisions

### D1 — The label map is opaque

`CreateSandboxMeta.podLabels` is `Record<string, string>`. The harness stamps
each entry and reads no key and no value. A label key, a label value, and the
meaning of both belong to the host. This removes the whole class of defect that
this change repairs: the harness cannot read the wrong key out of a map that it
never inspects.

The host gives the map in final form. Nexus pull request #145 gives
`{ "cortex/billing-context": "<uuid>", "cortex/user-id": "<uuid>" }`.

### D2 — The harness keeps the two identifiers that it holds itself

`cortex/analysis-id` and `cortex/run-id` stay derived from `CreateSandboxMeta`,
on both the Job and the pod template. They are facts of the run, not host policy,
and the harness already has them. A host that wants them under a different key
adds that key to its own map.

### D3 — `sanitizeLabelValue` stays on every value

The host promises a valid label value, but one malformed value makes the API
server reject the whole Job at admission, and the step then loses its sandbox.
The guard costs one pass over a small map. Keep it.

### D4 — The resolution stays inside the `sandbox.create` step

A separate `podLabels.resolve` DBOS step would shift the child workflow's step
sequence, and an in-flight workflow that resumes across the deploy would replay
against a different sequence. The resolution stays in the same checkpointed
closure as the spawn, as it did before.

### D5 — Attribution never fails a step

An absent seam spawns with no host label and says nothing: the host chose to
attribute nothing. A wired seam that throws, or that gives an empty map, warns
and spawns with no host label. The warning is the loud case, because there the
host asked for attribution and did not get it.

## Risks / Trade-offs

- [The harness cannot make sure that the labels are correct] → deliberate. A
  wrong label is a host defect, and the host owns the meaning. The staging check
  of the pod labels is the control.
- [`resolvePodLabels` is a breaking dep change] → minor version 0.20.0, and each
  embedder that wired `resolveBilling` into these two bundles rewires it.
