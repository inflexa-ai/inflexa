# prov-harness-bridge Specification (delta)

## MODIFIED Requirements

### Requirement: The artifact-registry bus adapter translates registration into provenance events

The cli SHALL provide an `ArtifactRegistry` realization (the bus adapter, in
`src/modules/harness/`) whose `register(input, session)` translates one step's
registration into bus events and nothing else. The adapter emits COMMAND, FILE, and
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
- **THEN** the bus receives two `prov.command_executed` events (one `command` variant with two outputs, one `file_tool` variant with one output), each followed by its `prov.file_written` events, and the result reports three `registered` entries

#### Scenario: A leaf entry emits no command event

- **WHEN** a manifest entry has no collector record for its path
- **THEN** no `prov.command_executed` references it and its `prov.file_written` carries `producer: "command"` (the existing inotify-only fallback) — its generation edge falls to the step activity in the document

#### Scenario: An intra-step read becomes a command-scoped input

- **WHEN** a command's record contains an `"artifacts"`-source read of a path that another group in the same registration produced
- **THEN** that command's `prov.command_executed` lists the read among `inputs` in its analysis-scoped form with `source: "step"`, while the step-level `prov.input_used` events still skip it

#### Scenario: A phantom self-read is dropped, not dangled

- **WHEN** a command's record contains an `"artifacts"`-source read of a path absent from the reconciled manifest (written then deleted)
- **THEN** the read appears in no event — no `used` edge references an unregistered entity
