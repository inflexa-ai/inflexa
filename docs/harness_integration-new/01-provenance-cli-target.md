# CLI tsprov Provenance — The Target Model (verified 2026-07-02, post-merge tree)

This is the system the harness must feed. Everything below was re-verified against the
current tree (not inherited from the old `docs/harness_integration/` report).

## 1. Dependency and confinement

- `"@inflexa-ai/tsprov": "0.2.0"` (`cli/package.json:22`, resolved from GitHub Packages).
  tsprov is a TS port of Python's `prov`: full W3C PROV data model, serializers
  `"json" | "provn"` (PROV-N is **serialize-only** — deserialize throws).
- Runtime tsprov usage is confined to **one file**: `cli/src/modules/prov/document.ts:3`.
  All other imports are type-only (`prov.ts:1`, `export.ts:3`, `tui/commands.tsx:5`).
  Stated intent (`document.ts:10-12`): "a tsprov fault is contained to provenance."
- **No `@inflexa-ai/harness` import exists anywhere in `cli/src` today** (grep verified).
  The cli↔harness wiring is greenfield.

## 2. PROV model mapping

Namespace: `inflexa` → `https://inflexa.ai/prov#` (`document.ts:20-22`).
QName sanitizer: `s.replace(/[^A-Za-z0-9_-]/g, "_")` (`document.ts:25-27`).

| Domain object | PROV concept | QName | Attributes |
|---|---|---|---|
| Analysis (document subject) | Entity `inflexa:Analysis` | `inflexa:analysis-{id}` | name, slug |
| Analysis input | Entity `inflexa:Input` | `inflexa:input-{Bun.hash(anchorId\|path).toString(36)}` — stable so add+remove touch the same entity | path, isDir |
| Recorded action | Activity, `startTime == endTime` | `inflexa:action-{randomUUIDv7()}` | `prov:type` ∈ CreateAnalysis / AddInput / RemoveInput |
| User | Agent (`prov:Person`) | `inflexa:agent-user-{qnameSafe(email)}` | email |
| Anonymous | Agent (`prov:Person`) | `inflexa:agent-anonymous` | label |
| The CLI | Agent (`prov:SoftwareAgent`) | `inflexa:agent-system` | version, commit (baked at build; crash-if-missing, `lib/env.ts:106-121`) |

Relations: creation → `wasGeneratedBy(analysis, action)` + `wasAttributedTo(analysis, agent)`
(`document.ts:116-120`); input added → `used(action, input)` + `wasAttributedTo(input, agent)`
+ `wasDerivedFrom(analysis, input)` + optional cross-analysis
`wasDerivedFrom(input, inflexa:analysis-{sourceId})` (`document.ts:123-130`); input removed →
`wasInvalidatedBy(input, action)` (`document.ts:133-137`). Every action also gets
`wasAssociatedWith(action, agent)` (`document.ts:111`).

Duplicates are deliberately not deduped at append time — `unified()` collapses by
identifier at serialize time (`document.ts:16-18`). This makes appends **idempotent
under replay**, which matters for DBOS-recovery re-emits.

`ProvActor` (`cli/src/types/prov.ts:18-27`):
`{kind:"user",email} | {kind:"anonymous"} | {kind:"system",version,commit}` —
**no harness/model-agent kind exists yet**; `appendAgent`'s exhaustive switch throws on
unknown kinds (`document.ts:63-67`), so a new actor kind is a required addition.

## 3. Storage and integrity

Provenance = four columns on `analyses` (baseline migration v1,
`cli/src/db/primary_migrations.ts:29-44`): `provenance` (PROV-JSON text),
`provenance_chain_hash`, `provenance_signature`, `provenance_prev_chain_hash`.
No separate prov table, no per-record rows.

- Write: `updateAnalysisProvenance(id, provenance, chainHash, signature)` — single
  atomic UPDATE that rotates `prev_chain_hash ← chain_hash`
  (`cli/src/db/primary_mutation.ts:319-332`). All three args required — unsigned
  provenance is never written. Doesn't bump `updated_at` (recorded metadata, not a
  user edit).
- Read: `getAnalysisProvenance(id)` (`primary_query.ts:298-303`),
  `getAnalysisIntegrity(id)` → `{provenance, prevChainHash, chainHash, signature}`
  (`primary_query.ts:305-332`).
- Chain hash: `SHA-256(prevBytes || provJsonBytes)`, empty seed `SHA-256("")`
  (`modules/prov/signing.ts:214-236`). Signature: Ed25519 over the chain hash;
  keypair JWK at `{configDir}/inflexa/prov_key.json`, generate-on-first-use,
  race-safe via temp-file + `linkSync` (`signing.ts:82-162`).

**Never-unsigned is enforced at three layers**: flush skips persist on signing failure
and retries later (`prov.ts:156-177`), the mutation requires all three columns
(`primary_mutation.ts:310-311`), export hard-fails without a signature (`export.ts:46`).
This matches the standing policy; note the *specs* still describe degrade-to-unsigned —
see §6.

## 4. Write path end-to-end (today: 3 events only)

```
modules/analysis/analysis.ts emits            Bus ("inflexa" channel, in-process
  prov.analysis_created  (analysis.ts:216-225)  EventEmitter singleton, lib/bus.ts:26)
  prov.input_added       (analysis.ts:128-141)   ↓
  prov.input_removed     (analysis.ts:152-163) modules/prov/prov.ts::onEvent (68-98)
                                                 ↓ append* on live ProvDocument
                                               scheduleFlush → setTimeout 0 coalesce
                                                 ↓ (crash window accepted, prov.ts:142-144)
                                               unified().serialize("json")
                                                 → chain hash → Ed25519 sign
                                                 → updateAnalysisProvenance
```

- Recorder subscribed at startup: `initProvenanceRecording()` (`cli/src/index.ts:22`);
  shutdown flush registered at `index.ts:25`.
- Live docs rebuilt from stored PROV-JSON per analysis; corrupt JSON → fresh doc
  (`prov.ts:100-140`). Events for unknown `analysisId` are **dropped**
  ("prov event for unknown analysis; skipping", `prov.ts:115`).
- Actors: `currentUserActor()` (auth → user, else anonymous) and `systemActor()`
  (`prov.ts:27-39`).

## 5. Read/export paths (all content-agnostic — harness records ride for free)

- `inflexa prov export <analysis> [--format json|provn] [--output <file>]`,
  `prov verify`, `prov verify-file` (`cli/src/cli/index.ts:154-177`).
- JSON export returns the **exact stored bytes** (verifiable against the chain);
  PROV-N is lossy/unverifiable (`export.ts`, `document.ts:146-153`). DSSE-style
  sidecar `<dest>.sig.json` with JWK public key (`verify.ts:157-204`).
- `VerifyResult` has 8 variants (`types/prov.ts:44-52`).
- TUI palette entries `prov.export-json/export-provn/verify/verify-export`
  (`tui/commands.tsx:685-769`). No UI renders the PROV graph itself; the sidebar only
  uses input events as a count-invalidation signal (`tui/layout/sidebar.tsx:67-86`).

## 6. Spec-vs-code drift (cli/openspec/specs) — fix specs during integration work

1. `prov-chain/spec.md:36-40` + `prov-signing/spec.md:27-32` describe
   degrade-to-unsigned flush. Code never persists unsigned. **Specs stale.**
2. `prov-chain/spec.md:42-49` + `data-model-storage/spec.md:86-99` describe v2/v3
   ALTER TABLE migrations; actual schema is a single baseline v1 with all four columns,
   and no spec mentions `provenance_prev_chain_hash`.
3. `prov-verify/spec.md:66-74` lists 5 VerifyResult variants; code has 8.
4. `prov-verify/spec.md:120-123` says export-without-signature writes no sidecar;
   code fails the export entirely.

No spec covers the recorder/bus-event side of provenance at all.

## 7. Extension seams for harness-originated provenance

Ordered by fit with how the system is built to grow:

1. **Typed bus events → recorder appends (the sanctioned seam).** New `BusEvent`
   members in `cli/src/types/events.ts` (event-per-action, per CLAUDE.md event-bus
   convention), new `append*` builders in `document.ts`, new `onEvent` cases in
   `prov.ts:69`. The cli translates harness callbacks into `Bus.emit("inflexa", …)`.
   `docs/audit.md:167-169` already anticipates exactly this
   (`prov.message_sent`, `prov.tool_invoked` style).
2. **Actor model must grow** — add a harness/agent actor kind (a `prov:SoftwareAgent`
   with model/tool identity; consider `actedOnBehalfOf(user)` — tsprov supports
   `ProvDelegation`, cli never uses it yet).
3. **Document-merge alternative**: tsprov `ProvDocument.update(other)` / `addBundle`
   could merge a whole harness-produced PROV doc; unused today, but `unified()`
   dedup makes merge-then-unify safe. (The old research rejected tsprov-in-harness —
   see 03-provenance-migration-plan; this seam is noted for completeness.)
4. **Everything downstream is free** — flush/sign/verify/export are content-agnostic.

### Hard constraints for the integration design

- (i) Keyed by `analysisId` — harness contributions must resolve to an existing
  `analyses` row or they're silently dropped (`prov.ts:115`).
- (ii) The Bus is an in-process EventEmitter — same-process embedding works directly;
  any out-of-process harness would need a transport that does not exist today.
- (iii) Never-unsigned invariant (three enforcement layers, §3).
- (iv) Input entities identify by *path*, not content: `lib/hash.ts:7 sha256File`
  exists with **zero callers**. Content-hash identity for harness artifacts is new
  ground — but the harness already computes SHA-256s, so events can carry them as
  entity attributes.
- (v) Cross-document linking precedent exists: `derivedFromAnalysisId` via
  `detectSourceAnalysis` (`modules/analysis/analysis.ts:88-105`).

## Gaps carried from research

- `docs/prov.progress.md` (source of the "A/B decision" nomenclature referenced by
  `prov.ts:144` and `document.ts:18`) no longer exists; decisions survive only as
  code comments.
- tsprov 0.2.0 inspected from bun cache `.d.ts` only; full source at
  `~/repos/inflexa/tsprov` if implementation-level verification is needed.
