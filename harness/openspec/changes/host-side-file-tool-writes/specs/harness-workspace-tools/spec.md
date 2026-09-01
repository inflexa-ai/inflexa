## ADDED Requirements

### Requirement: write_file writes with the host filesystem and is confined to the working directory

The harness MUST expose a `write_file` tool as a factory closure
`createWriteFileTool({ mutator })` — a thin adapter over the `WorkspaceMutator`
seam (see the harness-durable-runtime spec). The mutator owns resolve + confine
+ host byte-write + provenance. The tool only declares the input schema (a
`path` and UTF-8 `content`) and forwards.

The mutator MUST resolve `path`
through `resolveForWrite` (relative → working directory, absolute
`/{resourceId}/...` → analysis root). It MUST confine the result to the working
directory of the agent. The mutator MUST write the bytes with the host
filesystem, under the resolved workspace root. No sandbox exec is part of the
write.

A write whose resolved path is in-tree but outside the working directory MUST
return an `out_of_prefix` data variant. The read-only `data/` inputs and the
directories of other runs are outside it. A write that escapes the analysis
tree (`..` traversal, a foreign analysis, an absolute out-of-tree path) MUST
return `out_of_scope`. Neither is a throw, a silent clamp, or a permissive
write — the model sees the rejection and corrects. Only an unexpected host I/O
failure causes a throw.

#### Scenario: A write inside the working directory succeeds

- **GIVEN** a step whose working directory is `runs/{runId}/{stepId}`
- **WHEN** the model invokes `write_file` with `path` `output/result.csv` and
  content
- **THEN** the mutator resolves the path against the working directory and
  confirms that it is inside
- **AND** it writes the bytes with the host filesystem
- **AND** it returns an `ok` data variant with the resolved
  `/{resourceId}/...` path and `bytesWritten`

#### Scenario: A write outside the working directory is out_of_prefix

- **GIVEN** the same step working directory
- **WHEN** the model invokes `write_file` with `path` `/{resourceId}/data/inputs/x.csv`
  (the read-only inputs tree)
- **THEN** the tool result MUST be an `out_of_prefix` data variant, no write
  MUST occur, and `execute` MUST NOT throw

#### Scenario: A traversal escape is out_of_scope

- **GIVEN** the same step working directory
- **WHEN** the model invokes `write_file` with a path that escapes the analysis
  tree (for example `../other-analysis/x.csv`)
- **THEN** the tool result MUST be an `out_of_scope` data variant and no write
  MUST occur

#### Scenario: A file-tool write reaches a later sandbox exec

- **GIVEN** a confined `write_file` that succeeded
- **WHEN** a later `execute_command` reads the same workspace path
- **THEN** the script sees the file through the analysis mounts, because the
  host write landed under the same resolved workspace root

### Requirement: edit_file writes with the host filesystem and is confined to the working directory

The harness MUST expose an `edit_file` tool as a factory closure
`createEditFileTool({ mutator, workspaceFilesystem, workingDir })`. The tool
composes the read seam (the fetch of the current content), a search-and-replace,
and `WorkspaceMutator.writeFile`. It obeys the same resolution and confinement
contract as `write_file`, with no path logic of its own.

Edit semantics:
replace `old_string` with `new_string`. `old_string` MUST occur in the file.
When `replace_all` is false (default), it MUST occur exactly once. The expected
outcomes (`file_not_found`, `not_found`, `not_unique`, `out_of_prefix`,
`out_of_scope`) MUST be data variants — never throws. The read surface MUST
read the post-edit content at the same path.

#### Scenario: A round-trip through edit_file and the read surface agrees on path

- **GIVEN** a step that edits `output/notes.md` with new content
- **WHEN** the read surface is then called with the same workspace path
- **THEN** it MUST return the post-edit content, because both surfaces resolve
  the path through the shared resolver

#### Scenario: A non-unique old_string is not_unique

- **GIVEN** an `edit_file` call with `replace_all` false whose `old_string`
  occurs more than once
- **THEN** the tool result MUST be a `not_unique` data variant that carries the
  occurrence count, and no write MUST occur

#### Scenario: An edit outside the working directory is out_of_prefix

- **GIVEN** a step whose working directory is `runs/{runId}/{stepId}`
- **WHEN** the model invokes `edit_file` with a target under `data/inputs/`
- **THEN** the tool result MUST be an `out_of_prefix` data variant and no
  write MUST occur

### Requirement: The mutate seam refuses a symlink escape

The mutate seam MUST refuse a write whose real target escapes the write
prefix. The prefix check of `resolveForWrite` compares path strings, and a
symbolic link can turn an in-prefix string into an out-of-prefix target. Thus,
before the byte-write, the seam MUST find the deepest ancestor of the resolved
path that exists. The seam MUST compare the realpath of that ancestor against
the write prefix.

If that realpath escapes the write prefix, the seam MUST refuse the write
with the `out_of_prefix` data variant. If the final component of the resolved
path is a symbolic link, the seam MUST refuse the write with the
`symlink_denied` data variant. The seam MUST make an absent parent directory
only inside the write prefix. Each refusal MUST be a data variant — never a
throw — and no bytes land.

#### Scenario: A symlinked ancestor that escapes the prefix is refused

- **GIVEN** a directory inside the working directory that is a symbolic link to
  a location outside the write prefix
- **WHEN** the model invokes `write_file` with a path under that directory
- **THEN** the realpath re-check refuses the write, the result is an
  `out_of_prefix` data variant, and no bytes land outside the prefix

#### Scenario: A symlinked final component is refused

- **GIVEN** an in-prefix path whose final component is a symbolic link
- **WHEN** the model invokes `write_file` with that path
- **THEN** the tool result is a `symlink_denied` data variant, and no write
  occurs through the link

#### Scenario: A parent directory is made only inside the prefix

- **WHEN** a confined write names a path whose parent directories do not exist
- **THEN** the seam makes those directories inside the write prefix only, and
  the write then succeeds

### Requirement: edit_file supports a bulk regex mode

`edit_file` MUST accept an optional `regex` flag. When `regex` is true, the
tool MUST interpret `old_string` as a JavaScript regular-expression pattern.
It MUST interpret `new_string` as the replacement text, in which a
capture-group reference (`$1`, `$2`, ...) is legal. A regex call MUST carry
`expected_matches` (an exact count) or `replace_all: true`. A call with
neither MUST return an invalid-input data variant and write nothing.

When the
actual match count differs from `expected_matches`, the tool MUST write
nothing. The result MUST then report the actual count and the line numbers of
the matches. When `regex` is absent or false, the exact-string mode MUST apply
unchanged. A regex replacement MUST write through the same `mutator.writeFile`
chokepoint as the exact-string mode.

#### Scenario: A regex replace with the expected count succeeds

- **GIVEN** a file in which the pattern matches 3 times
- **WHEN** the model invokes `edit_file` with `regex: true` and
  `expected_matches: 3`
- **THEN** the tool replaces the 3 matches, applies each capture-group
  reference in `new_string`, and writes once through the mutator chokepoint

#### Scenario: A count mismatch writes nothing

- **GIVEN** a file in which the pattern matches 5 times
- **WHEN** the model invokes `edit_file` with `regex: true` and
  `expected_matches: 3`
- **THEN** the tool writes nothing, and the result reports the actual count 5
  and the line numbers of the 5 matches

#### Scenario: replace_all replaces every match

- **GIVEN** a file with more than one match
- **WHEN** the model invokes `edit_file` with `regex: true` and
  `replace_all: true`
- **THEN** the tool replaces every match and writes once through the mutator
  chokepoint

#### Scenario: A regex call without a match contract is invalid

- **WHEN** the model invokes `edit_file` with `regex: true` and neither
  `expected_matches` nor `replace_all: true`
- **THEN** the tool result is an invalid-input data variant and no write occurs

#### Scenario: The default mode is unchanged

- **WHEN** the model invokes `edit_file` without `regex`
- **THEN** `old_string` is a literal string, and the exact-string rules
  (`not_found`, `not_unique`, `replace_all`) apply unchanged

## REMOVED Requirements

### Requirement: write_file is sandbox-gated and confined to the working directory

**Reason**: The write ran as a `python3 -c` exec in the sandbox, but the seam
never used the exec frame for provenance. The sandbox gave containment only,
and the hardened host path check now gives that containment.

**Migration**: The replacement requirement "write_file writes with the host
filesystem and is confined to the working directory" keeps the tool shape, the
resolution, and the data variants. Only the byte-write moves to the host.

### Requirement: edit_file is sandbox-gated and confined to the working directory

**Reason**: The same reason as `write_file`. The whole-content write rode the
sandbox exec, but the exec gave no provenance value.

**Migration**: The replacement requirement "edit_file writes with the host
filesystem and is confined to the working directory" keeps the edit semantics
and the data variants. The new regex-mode requirement adds the bulk edit.
