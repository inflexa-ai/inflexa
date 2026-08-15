## Context

The value tier already runs a fixed extraction script in an ephemeral sandbox (`tasks/extract-values.ts`): the `SandboxClient` submit and await, the sandbox identity, the run authorizer on every terminal path, and no ledger entry. The session state is one durable row for each thread (`state/report-session-state.ts`), and the gateway serves the stored snapshot to every tool (`app/report-session-runtime.ts`). The snapshot is the membership boundary of a session.

## Goals / Non-Goals

- Goal: the agent reshapes pinned evidence into a table that a block can bind, with a recorded provenance chain.
- Goal: the derivation is repeatable: the record pins the script hash, the source hashes, and the output hash.
- Non-goal: an analysis run. No run id, no `cortex_runs` row, no `cortex_artifacts` row, and no write outside the session directory.
- Non-goal: a network. The sandbox rails give none, and the derivation keeps that.
- Non-goal: a change to the run agents or to the sandbox standards.

## Decisions

- **The tool is `derive_table`, on the report roster.** The input: a Python script, the declared pinned input paths, and one output file name. The output lands under the session `derived/` directory, named by the tool from the declared name.
- **The rails are the extraction rails, generalized to an agent-authored script.** The tool draws the same seams as the value tier: the sandbox client, the identity mint, and the authorizer on every terminal path. The container is ephemeral, and it goes away with the work.
- **The mounts are the difference.** The analysis tree mounts read-only, the shape that the substrate gives every sandbox. One write mount covers the session `derived/` tail alone, thus no write can reach the workspace tree. The script output lands in the write mount directly, thus a large table makes no roundtrip.
- **The mount plan gains one declared write tail.** `CreateSandboxMeta` takes an optional workspace-relative `writableTail`, and the plan uses it in place of the step tail, with no step subdirs. Each tail segment passes the safe-id discipline of the step builder. An absent field keeps the plan of today, thus the run path stays byte-identical.
- **The inputs are declared, and the record pins them.** Each input path must sit in the served membership, and its hash comes from there. The declaration is the provenance contract. The read reach equals the read-only roster reach, and the declared-input wall is a later hardening of the mount plan.
- **The record lives in the session state.** The row gains a derivation list. One record holds the output path, the output hash, the source paths with their hashes, the script hash, and the script text. The script text rides the record, thus the verifier re-runs it without a second store.
- **The served membership merges the records.** The gateway load extends the served snapshot artifacts with each derivation output, keyed by its session-relative workspace path. The stored pin never changes, thus the anchor stays honest and the merge is recomputable.
- **The structural tier and the resolvers stay unchanged.** They read the served snapshot, thus a derived table binds, resolves, and validates the same way as a pinned one.
- **The purge covers `derived/`.** The session page disposal removes the session directory whole, and the tests state that `derived/` goes with it.
- **The bounds.** One derivation runs at a time for a thread. The script caps at 64 KiB, the declared inputs at 20, and the output at one file. The exec budget matches the extraction budget.

## Risks / Trade-offs

- [An agent-authored script fabricates a table] → the record chains the output to the pinned sources and the script. The verifier can run the script again, thus fabrication leaves a reproducible trail.
- [A script writes junk beside the output] → the write mount is one directory, and the tool records and serves the declared output alone. A stray file dies with the purge.
- [Two turns derive one name] → the tool refuses a name that a record already holds. A record is immutable, and a rerun takes a new name.

## Open Questions

None.
