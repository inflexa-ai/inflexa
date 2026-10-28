# Spec Delta

## MODIFIED Requirements

### Requirement: The conversation agent holds the write pair confined to the analysis root

The conversation agent MUST hold `write_file` and `edit_file`. The
composition root MUST wire the two tools over a session-scoped
`WorkspaceMutator` realization. That realization MUST resolve the workspace
root per call, from the analysis scope of the session. The working directory
of the conversation agent is the analysis root, thus a write can land in its
own analysis tree.

The staged inputs under `data/inputs/` are immutable. The session-scoped mutator MUST refuse a write or an edit under them with the `read_only` data variant, before any I/O. The variant carries a `reason` that names `data/inputs/`. The landing MUST also refuse, as `read_only`, a target whose real path is under the staged inputs. Thus a symbolic link cannot aim a write into them. A write of a sandbox step under `data/` stays `out_of_prefix`, because the working directory of the step excludes `data/`.

The confinement MUST NOT become weaker. A `..` traversal, a foreign analysis,
and an out-of-tree path give `out_of_scope`. The symlink checks of the mutate
seam refuse a symlink escape. The chat route holds no sandbox, and the write
path uses none.

A scope that is not an analysis scope has no workspace tree. A write under
such a scope MUST give `out_of_scope` before any I/O.

#### Scenario: A chat write lands inside the analysis tree

- **GIVEN** the conversation agent on the chat route
- **WHEN** the model invokes `write_file` with the path `notes/summary.md`
- **THEN** the mutator resolves the path against the analysis root and writes
  the bytes with the host filesystem
- **AND** the result is an `ok` data variant with the `/{resourceId}/...`
  path and `bytesWritten`

#### Scenario: A chat write that escapes the tree is refused

- **WHEN** the model invokes `write_file` with `../other/x.csv` or with
  `/{otherAnalysisId}/x.csv`
- **THEN** the result is an `out_of_scope` data variant and no write occurs

#### Scenario: A symlink escape is refused in the chat context

- **GIVEN** a symbolic link inside the analysis tree with a target outside it
- **WHEN** the model invokes `write_file` with a path through that link
- **THEN** the mutator refuses the write, and no byte lands outside the tree

#### Scenario: A chat write or edit of a staged input is read_only

- **GIVEN** a staged input at `data/inputs/f1/counts.csv`
- **WHEN** the model invokes `write_file` or `edit_file` on that path, or `write_file` on a new path under `data/inputs/`
- **THEN** the result is a `read_only` data variant with a `reason` that names `data/inputs/`
- **AND** the input bytes stay unchanged, and no provenance event is emitted

#### Scenario: A symbolic link into the staged inputs is read_only

- **GIVEN** a symbolic link in a step directory whose target is a directory under `data/inputs/`
- **WHEN** the model invokes `write_file` with a path through that link
- **THEN** the result is a `read_only` data variant, and the input bytes stay unchanged
