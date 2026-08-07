# Adopt @inflexa-ai/prov-kernel as the provenance format authority

## Why

The published `@inflexa-ai/prov-kernel@0.3.0` owns the Inflexa PROV dialect: the document model
(QName derivation, unify options, injectable digest), the core nine-event union with
`applyProvEvent` as the sole supported producer of core statements, the chain-hash and Ed25519
sign/verify primitives, and the signed-sidecar schema. The cli carries a full local copy of all of
that in `modules/prov/document.ts`, `signing.ts`, `verify.ts`, and `types/prov.ts`. Two copies of a
signed format fork silently: a fix in one produces different bytes than the other, and the bytes
are what the chain hash signs.

## What Changes

- The cli deletes its local dialect code and consumes the kernel. `document.ts` shrinks to the
  model construction (`createProvDocumentModel` with the cli's historical digest and
  `randomUUIDv7` action ids) plus the cli-specific column serialization. `signing.ts` keeps only
  the key-FILE lifecycle (generate-on-first-use, JWK persistence, race-safe adoption); the
  primitives come from the kernel. `verify.ts` keeps the storage reads and command wiring over the
  kernel's verify/sidecar functions. `types/prov.ts` re-exports the kernel value types.
- The recorder's per-event builder switch becomes one `applyProvEvent` call; a `prov.*` bus member
  maps onto its kernel event by stripping the bus envelope. The recorder lifecycle — SQLite
  snapshot columns, revision-guarded dirty tracking, coalesced single-flight flush,
  rehydration-on-first-touch — is unchanged and stays cli-owned.
- Two continuity invariants are pinned by a compatibility fixture generated with the pre-kernel
  code: the injected digest (`Bun.hash(s).toString(36)`) and the user-agent identity (`id` = the
  email the cli historically keyed by). See `design.md`.
- Accepted forward delta: the kernel omits `inflexa:args` when a command's argument vector is
  empty; the pre-kernel code wrote `inflexa:args: ""`. Existing documents keep the old value under
  `unified()`; new documents never carry it.
- The exported sidecar schema gains the kernel's optional `kid` field (the cli does not set it).
- `package.json` adds `@inflexa-ai/prov-kernel@^0.3.0`; `@inflexa-ai/tsprov@0.5.1` stays (kernel
  peer).

## Capabilities

### New Capabilities

<!-- None. The change moves format ownership; every behaviour lands in an existing cli spec. -->

### Modified Capabilities

- `prov-run-events`: the statement builders are the kernel's; the recorder produces core
  statements exclusively through `applyProvEvent` over a model with the cli's injected digest.
- `prov-signing`: the sign/verify/chain-hash primitives are consumed from the kernel; the cli owns
  only the keypair file lifecycle.
- `prov-verify`: the verification functions, result formatting, and the sidecar schema are the
  kernel's; the cli owns the storage reads and the command wiring.

## Impact

CLI source:

- `src/types/prov.ts` — re-exports the kernel types; documents the two identity conventions.
- `src/modules/prov/document.ts` — model construction + `provSubject` + `serializeProvenance`.
- `src/modules/prov/signing.ts` — key-file lifecycle only.
- `src/modules/prov/verify.ts` — storage reads + command wiring over kernel verify/sidecar.
- `src/modules/prov/prov.ts` — `applyProvEvent` dispatch; actor construction gains `id`/`label`.
- `src/modules/prov/lineage.ts`, `src/modules/harness/prov_bridge.ts`, `src/tui/commands.tsx` —
  import updates; behaviour unchanged.
- `src/modules/prov/kernel_compat.test.ts` + `__fixtures__/kernel_compat.json` — the continuity
  suite over the pre-kernel fixture.

Dependencies: `@inflexa-ai/prov-kernel@^0.3.0` (new), peer-satisfied by the existing tsprov pin.

Out of scope: moving the recorder lifecycle, the bus contract, the lineage read side, or the
keypair file location — all stay cli-owned.
