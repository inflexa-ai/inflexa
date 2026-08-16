# Design: chain-and-prune-the-derivations

## Context

The ledger marks a claim binding and a citation binding, and a whole-table binding never joins (`src/report-render/references.ts`). The derivation records live in the durable session state (`src/state/report-session-state.ts:64`): the output path, the output hash, the sources with hashes, the script hash, and the script text. The served snapshot merges the records, thus a derived table binds, and the appendix stays blind to the chain.

## Decisions

### D1: The table and the chart mark their bindings

`renderTable` and the chart arm mark the block binding in the provenance ladder, and the card shows the marker beside its title. A figure marks today through its claim usage — its whole-file binding joins the same way, thus the rule reads: every evidentiary binding ledgers. The appendix entry of a whole-table binding names the path, as the artifact-table entry form already does.

### D2: The derivation records ride the render call

`renderReportPage` takes the derivation records beside the citation records, keyed by the output path. The appendix entry of a path that the records hold adds the chain line: each source path with its hash prefix, and the script hash prefix. The renderer stays pure, and the preview passes the records from the session state.

### D3: The unused set is a set difference at finish

A derivation is used when any binding of the document names its output path. The finish computes the difference over the records and the document. It lists each unused output as an advisory warning, in the existing warning channel. No file read joins, because the records and the document both sit in memory.

### D4: The record prunes files, and never records

After the gate passes and the version lands, the record tool removes the output file of each unused derivation under the session `derived/` directory. The records stay append-only, and the bytes are reproducible from the script and the sources. A failed removal logs and changes no outcome, exactly as the asset sweep does.

### D5: The prune reaches the derived directory alone

The prune resolves each unused output path, and it removes only a path under `report-sessions/{threadId}/derived`. A record whose path sits elsewhere is skipped, because the tool never deletes outside its own directory.

## Risks / Trade-offs

- A user can re-run a pruned derivation only through the agent, because the bytes are gone. The record keeps the script and the sources, thus the re-run is one tool call.
- The chain line lengthens the appendix. It rides only on a derived path, and the muted appendix style bounds the noise.
