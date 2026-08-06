# Swallow the core event switch

## Why

The event-to-statements mapping — "the big switch" — determines which
statements a document holds and in which order they append. Those statements
are the serialized document bytes, and the chain hash signs those bytes. Thus
the mapping is format, and the kernel owns format.

Before this change each host carried its own copy of the switch: the Cortex
recorder and the CLI recorder each mapped the same nine events onto the same
builders. A duplicated switch drifts. A host whose copy diverges mints
different statements for the same facts, and `unified()` keeps both — the
lineage graph forks. The reviewer's accepted suggestion is to move the switch
into the kernel, one time, next to the derivations it feeds.

## What Changes

- Add `src/events.ts`: the nine-variant core `ProvEvent` union
  (`analysis_created`, `input_added`, `input_removed`, `run_started`,
  `run_completed`, `step_completed`, `command_executed`, `file_written`,
  `input_used`) and `applyProvEvent(model, doc, event)` — the exhaustive
  switch that maps each event onto the model's builders. This is a move of
  reviewed host code, not a rewrite; the mapping semantics are unchanged.
- Export `ProvEvent` and `applyProvEvent` from the barrel. The builders and
  `appendLifecycleAction` stay exported: they are the extension mechanism for
  host-defined events.
- Add the "Events" section to `SPEC.md`: per core event, the statements it
  appends with their id schemes — the contract an independent writer
  implements against.
- Amend the boundary requirement: the kernel owns the core event union and
  the apply function. The recorder lifecycle, the emission policy, signer
  wiring, and extension events stay host-owned.
- Bump the package version from 0.2.0 to 0.3.0.

## Capabilities

### Modified Capabilities

- `prov-kernel`: the boundary requirement changes — the kernel now carries
  the core event union and the event-to-statements mapping.

## Impact

- `src/events.ts` (new), `src/events.test.ts` (new), `src/index.ts`,
  `SPEC.md`, `README.md`, `CLAUDE.md`, `package.json`.
- No host changes in this change. Each host adopts `applyProvEvent` in its
  own change: it deletes its local switch and keeps its recorder lifecycle
  and its extension events.
