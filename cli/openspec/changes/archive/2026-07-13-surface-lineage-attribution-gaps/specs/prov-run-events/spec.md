## ADDED Requirements

### Requirement: An unattributable script path is recorded on the activity

`appendCommandExecuted` SHALL stamp `inflexa:unresolvedScript` on the command
activity when it cannot resolve a `command` group's `scriptPath` against the
group's own outputs or its inputs, instead of dropping the path silently.
It SHALL still mint no entity and no `used` edge for the unresolved path — the
existing no-dangle rule stands; the gap becomes activity metadata, not a graph
node. The attribute SHALL be deterministic from the event payload, so replay
re-emission writes the identical value and dedups under `unified()`.

#### Scenario: An unresolvable script leaves a trace

- **WHEN** a `prov.command_executed` event carries `scriptPath: "scripts/de.R"` and no output or input `(path, hash)` of the group matches that path
- **THEN** the command activity carries `inflexa:unresolvedScript: "scripts/de.R"`, no entity exists for the path, and the activity has no script `used` edge

#### Scenario: A resolvable script is unchanged

- **WHEN** the group's inputs include `(scripts/de.R, sha256:…)` and `scriptPath` is `scripts/de.R`
- **THEN** the script's `used` edge is written exactly as before and no `inflexa:unresolvedScript` attribute appears

#### Scenario: Replay re-emission dedups

- **WHEN** the same `prov.command_executed` event is appended twice (workflow re-execution)
- **THEN** the flushed document carries the attribute once, on one activity record
