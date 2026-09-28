## MODIFIED Requirements

### Requirement: Extended message part union

The `Part` union in `src/types/session.ts` MUST be a discriminated union on `type`. It holds the message parts of the harness (`MessagePart`) and two mock part kinds that drive the stream blocks of the design gallery: a thinking part (a reasoning body and an optional duration) and a file-edit part (a file path, the hunk lines, and the counts of added and removed lines).

Each mock kind MUST have a distinct `type` literal, and it MUST carry only the fields that its block renders. Each mock kind MUST carry JSDoc on the type and on its properties. The mock kinds exist in memory only: the live chat engine does not make them, and no path stores them.

A harness part can carry screen state of the live turn, and no other field that the harness type does not declare. Three parts carry it:

- a text part: the key that `streamPartId` names while the part streams
- a tool-call part: the activity line of the sub-agent that works inside the running call
- an ask part: the reject feedback that the user typed

#### Scenario: Part union is a discriminated union

- **WHEN** code narrows a `Part` by `part.type`
- **THEN** each kind exposes only its own fields, and a switch over the harness part types and the two mock kinds is exhaustive

#### Scenario: New kinds are not persisted

- **WHEN** the live chat engine adds a part to a turn
- **THEN** the part is a harness part, and the mock kinds exist only as in-memory fixtures
