# Proposal: chain-and-prune-the-derivations

## Why

The provenance appendix ledgers a claim value and a citation alone, thus the derived chart of the session shows no provenance line at all. The derived directory also accumulates dead files: the session holds two tables that no block references, and nothing prunes the bytes. The decided direction of the tracker: an unused derivation gets a warning and a prune, and never a hard gate.

## What Changes

- The whole-table binding of a table block and of a chart block joins the provenance ledger. Thus every evidentiary block carries an appendix entry.
- The appendix entry of a derived path states its chain: the sources with their hashes, and the script hash, from the durable derivation record. The records ride the render call, exactly as the citation records do.
- The finish lists each unused derivation as an advisory warning, beside the free-numeral warnings. A warning decides no outcome.
- The record prunes the output files of the derivations that the recorded document does not reference. The records stay append-only, and the bytes are reproducible from them.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `report-render`: the whole-table bindings ledger, and the derived entry states the chain.
- `report-authoring`: the finish warns on an unused derivation.
- `report-verification`: the record prunes the unused derivation outputs.

## Impact

- Affected code: `src/report-render/references.ts` and the views, `src/report-render/render.ts`, the finish path, the record tool, `src/tools/report-session/preview-report.ts`, and their tests.
- A document with no derivation renders as before, and a session with no unused derivation prunes nothing.
