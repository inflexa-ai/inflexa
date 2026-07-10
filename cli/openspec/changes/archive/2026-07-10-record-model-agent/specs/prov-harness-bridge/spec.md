# prov-harness-bridge Delta Specification

## MODIFIED Requirements

### Requirement: The artifact-registry bus adapter translates registration into provenance events

The cli SHALL provide an `ArtifactRegistry` realization (the bus adapter, in
`src/modules/harness/`) constructed with the `ProvModelId` of the model driving the
step seat, whose `register(input, session)` translates one step's registration into
bus events and nothing else. The adapter emits COMMAND, FILE, and
USED-INPUT events — step lifecycle events come from the harness's scheduler
settlement:

- **Producer grouping**: partition the reconciled manifest entries by their
  collector record's `producer` object reference (the reference implementation's
  grouping — one group per command/file-tool execution surviving last-write-wins);
  entries with NO record form the LEAF bucket. The partition is exclusive: a file is
  in exactly one group or the leaf bucket, never both.
- Per group, emit ONE `prov.command_executed` (the `command` variant with command /
  args / exitCode / durationMs / scriptPath and the group's outputs as analysis-scoped
  `(path, hash)` keys; the `file_tool` variant with the tool name and outputs),
  stamped with the construction-time model id,
  followed by that group's `prov.file_written` events carrying `generation:
  "command"`; leaf-bucket entries emit `prov.file_written` with `generation:
  "step"`. The producer's observation timestamp SHALL NOT be forwarded.
- **Command-scoped inputs**: the group's `inputs` are its record's per-command reads
  with `source ∈ "data" | "upstream" | "prior"` passed through (container paths
  stripped to analysis-relative), and `source: "artifacts"` reads — the step's own
  prior outputs — RESOLVED to their analysis-scoped `runs/{runId}/{stepId}/…` form
  and included ONLY when that path is present in the reconciled manifest (a read of
  a written-then-deleted phantom is dropped: its entity was never registered and the
  edge would dangle). This is what makes intra-step chains representable at command
  scope while the step-level registry continues to skip `"artifacts"` reads.
- Manifest entries arrive STEP-relative; the adapter SHALL scope paths to the
  analysis-scoped form for events, QName seeds, and the `registered[].path`
  write-back key, as before.
- Emit `prov.input_used` once per tracked input ref (skip `source: "artifacts"`),
  and report hash-less entries or refs in `failed` — both unchanged from the prior
  revision.
- The result SHALL report each emitted entry in `registered` with the file's
  deterministic PROV QName as `externalId`; `sync()` SHALL be a local no-op; the
  adapter SHALL NOT write to `cortex_artifacts` or any harness-owned table and SHALL
  NOT emit `prov.step_completed`.

#### Scenario: Registration emits command groups before their files

- **WHEN** `register` is called with three manifest entries where two share one command's producer record and one was written by a file tool
- **THEN** the bus receives two `prov.command_executed` events (one `command` variant with two outputs, one `file_tool` variant with one output), each carrying the construction-time model id and followed by its `prov.file_written` events, and the result reports three `registered` entries

#### Scenario: A leaf entry emits no command event

- **WHEN** a manifest entry has no collector record for its path
- **THEN** no `prov.command_executed` references it and its `prov.file_written` carries `producer: "command"` (the existing inotify-only fallback) — its generation edge falls to the step activity in the document

#### Scenario: An intra-step read becomes a command-scoped input

- **WHEN** a command's record contains an `"artifacts"`-source read of a path that another group in the same registration produced
- **THEN** that command's `prov.command_executed` lists the read among `inputs` in its analysis-scoped form with `source: "step"`, while the step-level `prov.input_used` events still skip it

#### Scenario: A phantom self-read is dropped, not dangled

- **WHEN** a command's record contains an `"artifacts"`-source read of a path absent from the reconciled manifest (written then deleted)
- **THEN** the read appears in no event — no `used` edge references an unregistered entity

### Requirement: The cli realizes the callback as bus emission with the system actor

The cli composition SHALL realize `emitProvenance` by mapping all three harness arms
to bus events: `run_started` → `prov.run_started` (run ref with `planSummary` and
`startedAtMs`), `step_completed` → `prov.step_completed` (a `ProvStepOutcome` with
the settlement status, `completedAtMs`, and duration, stamped with the
construction-time `ProvModelId` of the model driving the step seat), and
`run_completed` → `prov.run_completed` (outcome with status, `completedAtMs`, and
duration) — each
stamped with the existing system actor (cli version + commit). The realization SHALL
be constructed with the `{provider}/{model}` name composed at boot: the RESOLVED
model id (the config override, or the proxy-default resolution when the config is
`null`) qualified by the provider slug — user-configured once provider+model
config lands; until then derived from the model family, `unknown` when
unrecognized — never a config `null` and never a credential. The mapping SHALL use
the harness-supplied `analysisId` unchanged and SHALL pass timestamps through without
re-reading any clock.

#### Scenario: Every executed step lands in the signed document

- **WHEN** `inflexa run` executes a plan where one step succeeds with artifacts, one succeeds with none, and one fails
- **THEN** the signed provenance document contains three step activities carrying statuses `completed`, `completed`, and `failed` — with true settlement times and durations, each associated with the model agent of the boot-resolved model

#### Scenario: A run whose host process ended is still recorded on recovery

- **WHEN** the cli process ends mid-run (detach, crash, or kill) and a later boot's DBOS recovery re-executes the workflow to a terminal status
- **THEN** the re-executed body re-fires `emitProvenance`, the recorder records the completion, and the unified document contains a single run activity whose times equal the original workflow-observed times

#### Scenario: An auto-resolved default model is recorded by its qualified resolved name

- **WHEN** `harness.model` is unset and boot resolves the proxy's default model id
- **THEN** the step events emitted during the run carry `anthropic/{resolved id}` in `model` (the auto-resolve path admits only Claude models) — never `null` or a placeholder

#### Scenario: An unrecognized model family records provider `unknown`

- **WHEN** `harness.model` is explicitly set to an id matching no known family (e.g. a proxy alias)
- **THEN** the step events carry `unknown/{configured id}` — the unattestable provider is recorded as exactly that, not guessed
