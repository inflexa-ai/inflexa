## 1. Storage

- [x] 1.1 Add `reported_usage jsonb` to the messages table — nullable, no default, so an unreported turn and a pre-existing row are both simply absent. The name is load-bearing: it sits beside `tokens`, and a reader must be able to tell an offline estimate from what a provider reported without consulting a doc
- [x] 1.2 Use `jsonb`, unlike the neighbouring `message_envelope`, and say why in the DDL comment — that column is `::json` so model content round-trips verbatim, a requirement a harness-generated fixed-shape record does not share
- [x] 1.3 Confirm the migration is additive and that an existing thread reads back unchanged, with every row's rollup absent
- [x] 1.4 Persist the wire-shaped `TokenUsageRollup` rather than a loop-local type — `contracts/` is the dependency-free shape hosts already read, and storage must not couple the row to a provider or loop type. One column, because the value is carried whole and never queried by quantity here; a per-quantity vocabulary would duplicate the wire shape and need a migration for every future count

## 2. The write path

- [x] 2.1 Widen `appendTurn` to accept an optional turn rollup, keeping the parameter optional so every existing caller compiles and behaves identically
- [x] 2.2 Attach it to the LAST assistant row the turn writes, inside the turn's existing transaction; a turn writing no assistant row stores none and still succeeds
- [x] 2.3 Preserve absent-means-not-reported end to end: no zeroing, no defaulting, and a rollup that reports nothing stored as absent — reuse the existing `hasReportedUsage` predicate rather than restating the rule, so the write and the loop cannot drift about what "reported nothing" means
- [x] 2.4 Test the write: the rollup lands on the assistant row and no other; a turn with no rollup stores none; a caller-supplied all-absent rollup stores none; a turn with no assistant row succeeds and stores none; a rolled-back turn leaves neither messages nor rollup
- [x] 2.5 Test that retracting the tail turn takes its rollup with it — free by construction, since the rollup is a column on the row, but pinned so a future move to a side table cannot silently orphan it

## 3. The read path

- [x] 3.1 Carry the stored rollup onto the `CortexMessage` its row produces, as an optional field
- [x] 3.2 Preserve it across assistant-row coalescing — the run keeps the rollup its last row carried, since coalescing is what rebuilds the one-bubble-per-turn shape
- [x] 3.3 Test the read: a stored rollup surfaces; a coalesced run keeps it; a row written without one converts cleanly

## 4. Keeping the two token numbers apart

- [x] 4.1 Verify `loadRecent` still windows solely by the `tokens` count and never reads the rollup
- [x] 4.2 Test that windowing is byte-identical with and without rollups stored, including a thread whose rollups dwarf its `tokens` counts — the regression that would silently break context budgeting
- [x] 4.3 Name and document both fields so a future reader cannot mistake an offline estimate for reported usage; the hazard is two plausible integers on one row

## 5. Verification

- [x] 5.1 `tsc --noEmit`, eslint, and the harness suite (`TESTCONTAINERS_RYUK_DISABLED=true bun test` — Ryuk fails on this host and its errors read as Postgres failures)
- [x] 5.2 Confirm at the package boundary that a host reading a thread receives the rollup — the harness ships this for an embedder, so an export it cannot see is not delivered
