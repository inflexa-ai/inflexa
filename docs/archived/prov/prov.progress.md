# Provenance (`prov`) module — progress

W3C PROV provenance for analyses, via `@inflexa-ai/tsprov`.

## Design (redesigned — bus-driven document, no event log)

**The provenance IS the PROV document.** No columnar event log, no `ProvEvent`. Each analysis's
provenance is a tsprov `ProvDocument`, persisted as its **PROV-JSON serialization** on a single
`analyses.provenance` column. It is read/written whole (export serializes; reopen deserializes),
never queried by interior field — so a blob column, matching `sessions`/`messages`/`parts`.

- **Recording is bus-driven and "dumb".** Analysis mutations (`createAnalysis`/`addInputs`/
  `removeInput`) emit typed `prov.*` bus events (`prov.analysis_created`, `prov.input_added`,
  `prov.input_removed`) — one event type per action, each carrying exactly the fields it needs;
  they never touch tsprov. The **recorder** (`modules/prov/prov.ts`) is a process-global bus subscriber.
- **In-memory append-only document.** On first touch the recorder rebuilds the live `ProvDocument`
  from the stored PROV-JSON (`deserialize`) — or seeds a fresh one — then `appendAction`s each event.
- **Async flush + sync exit backstop (decision A).** A coalesced `setTimeout(0)` flush keeps the
  column in sync during a session; `process.on("exit", flushProvenance)` guarantees the tail on a
  clean quit (DB stays open at exit). Crash between event and flush loses the un-flushed tail — the
  accepted trade-off for keeping recording off the synchronous mutation path.
- **`unified()` at flush (decision B).** Appends never de-dup; tsprov's `_idMap` tolerates duplicate
  identifiers and `unified()` collapses them (an agent re-declared across actions / across a reload)
  at serialize time. Verified against `bundle.d.ts:42,123`.
- **3 lifecycle events only (decision C):** `analysis_created`, `input_added`, `input_removed`.
  Chat-stream harvesting deferred.

### PROV mapping (unchanged from before, now appended incrementally)

| Domain thing          | PROV record                                                    |
|-----------------------|----------------------------------------------------------------|
| analysis              | Entity `inflexa:analysis-<id>` (`prov:type inflexa:Analysis`)   |
| an action             | Activity `inflexa:action-<uuid>` (typed per action)            |
| actor user/anon/system| Agent `inflexa:agent-user-<email>` / `-anonymous` / `-system`   |
| an input ref          | Entity `inflexa:input-<hash(anchor\|path)>`                     |

`analysis_created` → analysis `wasGeneratedBy`+`wasAttributedTo`. `input_added` → action `used`
input, input `wasAttributedTo`, analysis `wasDerivedFrom` input (+ `wasDerivedFrom` the source
analysis's subject when `derivedFromAnalysisId` is set). `input_removed` → input `wasInvalidatedBy`.

### Export formats

`json` → tsprov `serialize("json")` (PROV-JSON, also the storage form). `provn` → `serialize("provn")`
(PROV-N; serialize-only — `deserialize` rejects it, `document.d.ts:34`).

## Status

**✅ COMPLETE + VERIFIED.** typecheck + lint clean; `218 pass, 0 fail`.

- Deleted the whole columnar surface: `ProvEvent`, `prov_events` table, `ProvEventRow`/`COLS`/
  `fromRow`, `listProvEvents`, `insertProvEvent`, `recordAnalysisCreated/InputAdded/InputRemoved`,
  batch `buildProvDocument`. Migration v2 rewritten to `ALTER TABLE analyses ADD COLUMN provenance`.
- New: `getAnalysisProvenance`/`updateAnalysisProvenance` (column accessors; the update deliberately
  does NOT bump `updated_at` — provenance is metadata, like `touchAnchor`), `prov.recorded` bus
  event, `document.ts` builders (`freshDocument`/`loadDocument`/`appendAction`/`serializeProvenance`),
  the recorder in `prov.ts`, init+exit wiring in `src/index.ts`.
- **End-to-end smoke verified** against a fresh DB: `createAnalysis` (anonymous actor, no auth) +
  `removeInput` → bus → recorder → flush → column → PROV-N/JSON export. One input entity spans
  add+remove; the agent appears once (unified collapsed 3 re-declarations). `inflexa --help`/`ls`
  boot cleanly with the eager-tsprov startup import.
- Tests rewritten: `prov.test.ts` (pure `appendAction` build + dedup + JSON round-trip, and a
  bus→recorder→column integration incl. reopen-and-append); `primary_migrations.test.ts` asserts the
  `provenance` column instead of a `prov_events` table.

**Local dev note:** a dev DB already at migration v2 (old `prov_events`) won't pick up the rewritten
v2 — delete `$XDG_DATA_HOME/inflexa/agent.db*` so migrations re-run from scratch.
