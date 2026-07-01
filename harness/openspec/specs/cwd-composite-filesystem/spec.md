# cwd-composite-filesystem Specification

## Purpose

Defines the per-step working-directory convention for sandbox tools and the
composite mount it rests on. A sandbox container sees a **composite filesystem**:
a flat read-only mount of the whole analysis tree at `/{resourceId}`, plus a
nested read-write mount of just this step's artifact root at
`/{resourceId}/runs/{runId}/{stepId}`. That step root is the step's `workingDir`
— the implicit cwd for `execute_command` and the confinement prefix for the
write-side filesystem tools — while reads roam the full analysis tree
read-only.

Confinement is structural and non-throwing. Both the read surface and the
mutate surface resolve agent paths through one module
(`harness/src/workspace/paths.ts`): a relative path resolves against `workingDir`,
an absolute `/{resourceId}/…` path resolves against the analysis root regardless
of `workingDir`. The write side adds confinement via `resolveForWrite`, which
returns data variants — `out_of_scope` for a path that escapes the analysis tree
and `out_of_prefix` for an in-tree path outside the working directory — and
**never throws**, so the model can correct toward its working directory instead
of guessing why a write failed. Because both surfaces share the resolver, a file
a step writes is read back at the identical path.

## Requirements

### Requirement: Composite read-only tree plus writable step mount

A sandbox SHALL receive a flat read-only mount of the analysis tree at
`/{resourceId}` and a nested read-write mount of the step's artifact root at
`/{resourceId}/runs/{runId}/{stepId}`. Reads SHALL resolve against the read-only
tree; writes SHALL land in the nested writable mount only.

#### Scenario: Read reaches the read-only tree

- **WHEN** the agent reads `/{resourceId}/data/counts.csv`
- **THEN** the read resolves directly against the flat read-only analysis mount

#### Scenario: Write lands in the nested writable mount

- **WHEN** the agent writes a file under `/{resourceId}/runs/{runId}/{stepId}/`
- **THEN** the write lands in the step's nested read-write mount

### Requirement: Per-step writable root is the implicit cwd

The step's writable artifact root SHALL be `/{resourceId}/runs/{runId}/{stepId}`.
`execute_command` SHALL accept an optional `cwd`; when omitted it SHALL default to
the step's writable root (`defaultCwd`), a relative `cwd` SHALL resolve against
that root, and an absolute `cwd` SHALL be used as given. Absolute paths to the
read-only analysis tree (`/{resourceId}/...`) SHALL NOT be remapped.

#### Scenario: Relative command path resolves under the step writable root

- **GIVEN** the step's writable root is `/{resourceId}/runs/{runId}/{stepId}`
- **WHEN** the agent calls `execute_command({ command: "python scripts/qc.py" })` without a `cwd`
- **THEN** the command runs with cwd defaulted to the step's writable root
- **AND** `scripts/qc.py` resolves under `/{resourceId}/runs/{runId}/{stepId}/scripts/qc.py`

#### Scenario: Absolute path to the analysis tree is not remapped

- **WHEN** the agent calls `read_file("/{resourceId}/data/counts.csv")`
- **THEN** the read resolves directly against the flat read-only analysis mount

### Requirement: Write-side tools confine to workingDir via resolveForWrite

Write-side filesystem tools (`write_file`, `edit_file`) SHALL resolve and confine
agent paths through `resolveForWrite` (`harness/src/workspace/paths.ts`). A
resolved path inside the working directory SHALL return `ok`; an in-tree path
outside the working directory SHALL return the `out_of_prefix` data variant; a
path that escapes the analysis tree SHALL return the `out_of_scope` data variant.
Confinement SHALL be expressed as these data variants and SHALL NOT throw.

#### Scenario: Write inside the working directory succeeds

- **WHEN** the agent calls `write_file("scripts/qc.py", content)` resolving under `/{resourceId}/runs/{runId}/{stepId}/`
- **THEN** `resolveForWrite` returns `ok` and the write succeeds

#### Scenario: Write outside the working directory is out_of_prefix

- **WHEN** the agent calls `write_file("/{resourceId}/data/foo.txt", content)`, in-tree but outside the step's writable root
- **THEN** the tool returns the `out_of_prefix` data variant and performs no write

#### Scenario: Write escaping the analysis tree is out_of_scope

- **WHEN** the agent supplies a path that escapes `/{resourceId}/` (e.g. `..` traversal or another analysis id)
- **THEN** the tool returns the `out_of_scope` data variant and performs no write
