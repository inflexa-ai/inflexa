## MODIFIED Requirements

### Requirement: Extended message part union

The `Part` union in `src/types/session.ts` SHALL be a discriminated union on `type` that, in addition to the existing `TextPart`, includes mock part kinds sufficient to drive the stream blocks: a thinking part (reasoning body + optional duration), a tool-call part (tool/verb name, detail, result payload, status), and a file-edit part (file path, hunk lines, +/− counts). Each new kind SHALL carry only the fields its block renders, SHALL have a distinct `type` literal, and SHALL carry JSDoc on the type and its properties. The persisted/stored shape SHALL remain text-only — the new kinds are mock and SHALL NOT be written through the DB mutation path.

The tool-call part's description field SHALL be named `detail`, not `target`. It carries one opaque display string the harness computed from the call's input, and a verb phrase such as `hypothesis retire h3` is not a target — naming it `target` claims a semantic the value does not hold. The field remains optional: a tool that declares no call description produces none.

The tool-call part's status SHALL be `running | ok | error | denied`. `denied` records a refused approval, which is the user's decision rather than a failure of the tool.

#### Scenario: Part union is a discriminated union

- **WHEN** code narrows a `Part` by `part.type`
- **THEN** each kind exposes only its own fields, and the four discriminants (`text`, thinking, tool-call, file-edit) are exhaustive

#### Scenario: New kinds are not persisted

- **WHEN** the live chat engine creates a part through the DB mutation path
- **THEN** only the text kind is created; the mock kinds exist only as in-memory fixtures

#### Scenario: A live tool part carries a detail

- **WHEN** the emit adapter mints a tool-call part for a tool that declares a call description
- **THEN** the part's `detail` holds the harness-computed string, and no `target` field exists on the type

#### Scenario: The denied status is representable

- **WHEN** a tool-call part records a refused approval
- **THEN** its status is `denied`, narrowable separately from `error`
