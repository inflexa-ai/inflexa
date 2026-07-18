## Context

`inspectReferenceStore` (`src/modules/refs/store.ts`) already computes everything a programmatic consumer needs — per-dataset `ReferenceDatasetState` (`"missing" | "installed" | "update_available" | "partial" | "invalid_receipt"`), the active receipt, store existence, and unmanaged top-level content — but `runRefsList` renders it exclusively as human prose. `verifyReferenceDatasets` likewise returns a clean `ReferenceVerification[]` that `runRefsVerify` flattens into prose. The planner ref-awareness work (inflexa#155) needs this inventory as data, and out-of-process consumers (scripts, tests, the agent shelling out per the inflexa#130 design) have no stable surface at all.

Constraints: the human output of both commands must not change; inspection must stay side-effect-free (the existing "Path inspection does not litter" scenario); docs-gen fails on any option without a description; and the shell-out design for inflexa#130 forbids new harness surface — this is a CLI-only change.

## Goals / Non-Goals

**Goals:**

- A documented, byte-stable JSON mode on `refs list` and `refs verify` whose shape the CLI owns.
- One projection type per command, exported from `modules/refs`, usable in-process by inflexa#155 without going through a subprocess.
- Stdout purity in JSON mode: a complete JSON document or nothing.

**Non-Goals:**

- No harness change of any kind (no new catalog fields, no seam) — the projection is built CLI-side from data already returned.
- No JSON mode on `refs download` / `refs path` (`path` is already trivially machine-readable; `download` is an interactive/consenting flow, and the agent path reads its prose output like any tool output).
- No change to selection logic (`verify` with no ids still verifies exactly the receipted/invalid datasets).
- No schema-version field in the document (see Decisions).

## Decisions

**1. CLI-owned projection, not a raw dump of the harness types.**
Serializing `ReferenceStoreInspection` as-is would make the harness's `ReferenceDataset`/`ReferenceInstallReceipt` zod-inferred shapes the CLI's documented wire format — a harness release could then silently mutate output the CLI promised was stable, and interior details (receipt schema `version`, per-file digests) would leak into a surface meant for install-state questions. Instead `modules/refs/store.ts` exports explicitly constructed projection types + pure builder functions; every field is copied by name. Rejected alternative: `JSON.stringify(inspection)` — cheapest today, but transfers shape ownership to the harness and violates the "documented shape" promise.

**2. The projection is the shared artifact; the flag is its serialization.**
The planner (inflexa#155) runs in the CLI process and imports the projection type/builder directly (`modules/harness` → `modules/refs` is a legal acyclic module import). The `--json` flag serves out-of-process consumers and gives the shape an E2E-testable surface. Homed in `store.ts` beside the types it projects — it is module public surface, not command presentation.

**3. Self-contained document — artifact URLs always included.**
`--json` composes with no other flag: fewer flags means fewer ways for an agent (or script) to hold it wrong, and artifact URLs are static catalog data with no cost to include. `--urls` remains a human-output-only concern; combining `--json --urls` is not an error, `--urls` simply has no effect on the JSON document. Rejected alternative: gating URLs behind `--urls` in JSON mode — a leaner document, but creates two JSON shapes and an easy consumer mistake.

**4. List document shape** (field names final; TS type names decided at implementation):

```jsonc
{
  "root": "…",            // the public store path (env.refsDir) — same fact `refs path` prints
  "exists": false,          // whether the store root exists on disk
  "datasets": [
    {
      "id": "…",
      "version": "…",      // catalog (target) version
      "title": "…",
      "description": "…",
      "sourceUrl": "…",
      "license": { "identifier": "…", "url": "…" },   // url absent when the catalog has none
      "group": "…",          // flattened from the catalog's recommendation.group
      "recommended": true,    // flattened from recommendation.recommended
      "state": "missing",    // ReferenceDatasetState — the union verbatim
      "installedVersion": "…", // receipt.datasetVersion; present only in states installed/update_available
      "installedAt": "…",      // receipt.activatedAt (ISO 8601); same presence rule as installedVersion
      "artifacts": [ { "path": "…", "url": "…" } ]
    }
  ],
  "userContent": ["…"]   // unmanaged top-level entries, never adopted by the installer
}
```

`recommendation` is flattened to `group`/`recommended` so the wire shape does not encode the harness's interior nesting. Receipt exposure is deliberately limited to `installedVersion`/`installedAt` — per-file sizes/digests are verify's domain, and the receipt's own schema-version field is an implementation detail. The install facts appear only in the usable states (`installed`, `update_available`), not on bare receipt presence: a `partial` dataset can hold a valid receipt whose files are incomplete, and surfacing its receipt would make key presence contradict `state` and let a consumer misread a damaged install as usable. Absent-not-null: optional facts are omitted keys (native `JSON.stringify` behavior), never `null`.

**5. Verify document shape** — an object wrapping the dataset array, not a bare array (extensible, symmetric with list):

```jsonc
{
  "datasets": [
    {
      "datasetId": "…",
      "version": "…",     // active receipt version; absent when the receipt is missing/invalid
      "state": "valid",     // "valid" | "missing" | "invalid_receipt" | "modified"
      "files": [ { "path": "…", "state": "valid" } ]  // "valid" | "missing" | "modified"
    }
  ]
}
```

**6. Byte-stability mechanics.** Same store state ⇒ same bytes: dataset order is catalog order (already deterministic), key order is pinned by explicit literal construction, no timestamps or paths are minted at render time (`installedAt` is an install-time fact read from the receipt), and serialization is `JSON.stringify(value, null, 2)` plus a trailing newline. Two-space indent chosen over compact: byte-stability is equal, and indented output is directly readable by humans and LLM consumers without a formatting pass.

**7. Failure and exit-code contract.** In JSON mode stdout carries a complete JSON document or nothing. Inspection/verification *failure* (the operation itself could not run) prints prose to stderr and sets exit code 1 with empty stdout — exactly the human mode's error path; no JSON error envelope (rejected: it forces consumers to sniff document kind before parsing). Verify with *damaged datasets* is a successful verification whose findings are bad: the document is emitted on stdout AND exit code 1 is set, matching human mode. The human mode's advisory "Re-download to repair" stderr hint is suppressed in JSON mode — stderr stays reserved for genuine failures, and the document already carries the damaged states.

**8. No top-level schema-version field.** The documented shape in the spec is the contract; evolution is expected to be additive (new optional keys), which JSON consumers tolerate by construction. A version field would itself need governance (when to bump, who checks it) with no consumer today that would read it. Revisit only if a breaking reshape is ever actually needed.

## Risks / Trade-offs

- [Harness catalog gains fields the projection doesn't carry] → By design: new facts appear in the JSON only when deliberately added to the projection. The copy-by-name builders make the omission visible at the type level when a harness field is renamed/removed (compile error), which is the ownership working as intended.
- [Consumers parse human output anyway] → Unavoidable; the documented flag plus stdout purity make the JSON path strictly easier, and inflexa#155 consumes the type in-process.
- [Indented output inflates size] → Negligible at catalog scale (a handful of datasets); readability wins.
- [`--json --urls` accepted-but-inert may surprise] → Documented in the option description; erroring on the combination would punish harmless scripting.

## Migration Plan

Purely additive — new flag, new exports, human output untouched. No rollback concerns beyond reverting the commit.

## Open Questions

None — projection ownership, URL inclusion, serialization format, failure contract, and verify inclusion were the open forks and are decided above.
