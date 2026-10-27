## Why

A durable step can stop after its act lands and before its emit. A rerun of an authoring call or of a derivation that found its landed act emitted nothing, thus the record lost the act. A rerun of the spawn of a report session emitted `create-session` again. Thus the sites did not agree on one rule.

## What Changes

- A rerun that finds a landed act emits the events of the act again. A consumer gets each act at least one time.
- The stored result of an authoring call holds the events of the act, thus the rerun can emit them again.
- The spawn of a report session keeps its emit on a rerun.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `provenance-seam`: the emits of a rerun.

## Impact

- `src/tools/report-authoring/authoring-tools.ts`: `LandingCall` carries the events.
- `src/tools/report-session/derive-table.ts`.
- A consumer that counts acts can count an act two times after a crash.
