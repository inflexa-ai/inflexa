## Why

For a provenance tool, silent omission is worse than a loud "unknown" (inf-cli#75 Gap 3). `prov lineage` already hedges every empty branch ("no recorded inputs"), but it cannot distinguish "the record shows zero inputs" from "the recorder saw an attribution it could not resolve" — because the document builder silently drops the one such case it detects: a command's `scriptPath` that matches neither the group's outputs nor its inputs (`appendCommandExecuted`) leaves no trace in the graph. A reviewer reading the tree cannot tell an agent-authored file's *genuine* zero-input claim from a command whose script attribution was lost.

## What Changes

- `appendCommandExecuted` SHALL record an unresolvable script path on the command activity (`inflexa:unresolvedScript`) instead of dropping it silently — still no dangling entity and no `used` edge (the no-dangle rule stands); the gap becomes graph data.
- `prov lineage` rendering distinguishes the three absence kinds:
  - a `file_tool` activity's empty input side renders as a **positive** claim (agent-authored content — no file inputs by design), not the hedged wording;
  - a command activity's empty input side keeps the hedged "no recorded inputs";
  - an activity carrying `inflexa:unresolvedScript` renders the unresolved script inline in the tree and in the JSON projection (dot/mermaid labels inherit from the flat projection), and the tree ends with a note counting attribution gaps when any were rendered.
- Documents written before this change carry no `inflexa:unresolvedScript` and render exactly as today — graceful degradation, no migration.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `prov-run-events`: `appendCommandExecuted` gains a requirement that an unattributable `scriptPath` is recorded as a deterministic activity attribute rather than silently skipped.
- `prov-lineage`: rendering gains a requirement to distinguish recorded absence ("no recorded inputs") from by-design absence (agent-authored file-tool writes) and from attribution gaps (unresolved scripts), with tree/JSON parity and a trailing gap count.

## Impact

- `src/modules/prov/document.ts` — `appendCommandExecuted` unresolved-script attribute.
- `src/modules/prov/lineage.ts` — `LineageActivity` + `activityMeta` (read the attribute), `formatTree` (per-kind absence wording, inline gap line, trailing count), `formatJson` (expose the field; dot/mermaid derive from it).
- Tests: `lineage.test.ts`, `prov.test.ts`.
- Not affected: bus event shapes, the harness, the bridge, signing/verification (the attribute rides the normal record path; replay re-emission writes the identical value and dedups under `unified()`).
