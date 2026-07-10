## MODIFIED Requirements

### Requirement: The cli realizes the callback as bus emission with the system actor

The cli composition SHALL realize `emitProvenance` by mapping all three harness arms
to bus events: `run_started` → `prov.run_started` (run ref with `planSummary` and
`startedAtMs`), `step_completed` → `prov.step_completed` (a `ProvStepOutcome` with
the settlement status, `completedAtMs`, and duration, stamped with the
construction-time `ProvModelId` of the model driving the step seat), and
`run_completed` → `prov.run_completed` (outcome with status, `completedAtMs`, and
duration) — each
stamped with the existing system actor (cli version + commit). The realization SHALL
be constructed with the `{provider}/{model}` name composed at boot from two
CONFIGURED facts: the model connection's `provider` slug (see `model-connection` —
setup-recorded in `cliproxy` mode, user-stated in `direct` mode) and the RESOLVED
model id (the config override, or the cliproxy auto-resolution when the config is
`null`) — never a config `null`, never a credential, and never a provider derived
from the model id. The mapping SHALL use
the harness-supplied `analysisId` unchanged and SHALL pass timestamps through without
re-reading any clock.

#### Scenario: Every executed step lands in the signed document

- **WHEN** `inflexa run` executes a plan where one step succeeds with artifacts, one succeeds with none, and one fails
- **THEN** the signed provenance document contains three step activities carrying statuses `completed`, `completed`, and `failed` — with true settlement times and durations, each associated with the model agent of the boot-resolved model

#### Scenario: A run whose host process ended is still recorded on recovery

- **WHEN** the cli process ends mid-run (detach, crash, or kill) and a later boot's DBOS recovery re-executes the workflow to a terminal status
- **THEN** the re-executed body re-fires `emitProvenance`, the recorder records the completion, and the unified document contains a single run activity whose times equal the original workflow-observed times

#### Scenario: An auto-resolved default model is recorded under the configured provider

- **WHEN** the connection is cliproxy mode with a setup-recorded provider and `harness.model` is unset, and boot auto-resolves the proxy's default model id
- **THEN** the step events carry `{configured provider}/{resolved id}` in `model` — never `null`, a placeholder, or a family-derived slug

#### Scenario: A direct connection is recorded with its stated provider

- **WHEN** the connection is `{ mode: "direct", provider: "deepseek", … }` and the configured model is `some-alias-v2`
- **THEN** the step events carry `deepseek/some-alias-v2` — the configured facts verbatim; no `unknown/` fallback exists
