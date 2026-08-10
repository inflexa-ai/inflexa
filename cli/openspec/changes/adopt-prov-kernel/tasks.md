## 1. Capture the pre-kernel baseline (before any deletion)

- [x] 1.1 Generate `src/modules/prov/__fixtures__/kernel_compat.json` with the CURRENT
  implementation: a small document driven through every event kind with a frozen clock, its
  unified PROV-JSON, first-flush chain hash, Ed25519 signature by a throwaway keypair, the public
  JWK, the logical event list in kernel shape, and the `fileQName`/`commandQName`/
  `modelAgentQName` literals. Delete the one-shot generator after the run; the fixture stays.

## 2. Dependency

- [x] 2.1 Add `@inflexa-ai/prov-kernel@^0.3.0` to `package.json`; keep `@inflexa-ai/tsprov@0.5.1`
  (kernel peer). Update `bun.lock`.
- [x] 2.2 Bump to `@inflexa-ai/prov-kernel@^0.4.0` (lineage read model + attestation names).

## 3. Replace the duplicated dialect code

- [x] 3.1 `src/types/prov.ts`: re-export the kernel value types; document the two identity
  conventions (user `id` = email; system `label: "inflexa cli"`). Drop the unused `ProvActorKind`.
- [x] 3.2 `src/modules/prov/document.ts`: `createProvDocumentModel({ digest: cliProvDigest,
  mintActionId: randomUUIDv7 })`, `provSubject`, and the column-reading `serializeProvenance`.
  Delete the local builders, QName derivations, and unify options.
- [x] 3.3 `src/modules/prov/signing.ts`: keep the key-file lifecycle; import the JWK pair through
  kernel `importPrivateKeyJwk`/`importPublicKeyJwk`; delete the local chain-hash, digest, sign,
  and verify primitives. Error type becomes the kernel `ProvSigningError`.
- [x] 3.4 `src/modules/prov/verify.ts`: keep `verifyAnalysisIntegrity`, the two command actions,
  `readAttestation`, `verifyExportFile`, and a `buildAttestation` that wires the key file into
  kernel `createKeypairSigner` + `buildAttestation`; delete the local verify functions, formatter,
  and attestation schema.
- [x] 3.5 Adopt kernel 0.4.0's attestation naming end to end (`verify.ts`, `export.ts`,
  `commands.tsx`, `cli/index.ts` help text, tests): local wrappers, the `invalid-sidecar` →
  `invalid-attestation` status, and prose. The on-disk `.sig.json` suffix and JSON wire fields
  stay.

## 4. Recorder and consumers

- [x] 4.1 `src/modules/prov/prov.ts`: the event switch becomes `applyProvEvent(provModel, doc,
  toKernelEvent(event))`; `toKernelEvent` strips the bus envelope and its return type is the
  compile-time exhaustiveness guard. `currentUserActor` passes `id` = email; `systemActor` passes
  `label: "inflexa cli"`.
- [x] 4.2 `src/modules/harness/prov_bridge.ts`: `externalId` from `provModel.fileQName`; behaviour
  unchanged.
- [x] 4.3 `src/modules/prov/lineage.ts`: load through `provModel.loadDocument(provSubject(…))`;
  kernel `PROV_UNIFY_OPTIONS`.
- [x] 4.5 Move the lineage middle layer onto the kernel read model: `deriveLineageModel` replaces
  `loadDocument` + `lineageGraph` (the separate parse collapses); the kernel's `computeLineage`
  replaces the local walk (signature adapted: `(model, string[], { direction, depth? })`); delete
  `activityMeta`'s graph reads, `fileInfoOf`, `toFileInfo`-over-records, `firstAttr`,
  `fileEntities`, and the attribute-typed kind classification. Keep `resolveLineageRef`'s 5-tier
  search, `indexWalkEdges` + `buildRootTree`, the four formatters, `parseOptions`, and
  `runProvLineage` — observable behaviour identical. Re-derive depth truncation via a
  one-hop-wider kernel walk (the retired engine's frontier), and impose the unbounded-walk
  ceiling cli-side (500 file hops).
- [x] 4.4 `src/tui/commands.tsx`: the two verify palette commands lazy-import the kernel for
  `formatVerifyResult`.

## 5. Tests

- [x] 5.1 `src/modules/prov/kernel_compat.test.ts`: digest + QName pins, kernel
  `verifyProvenance` accepts the fixture, `loadDocument` rehydrates it, execution-event replay
  dedupes into it, user-agent QName from `id` = email, and the empty-args forward delta.
- [x] 5.2 Update `prov.test.ts` / `lineage.test.ts` to drive statements through `applyProvEvent`
  via local helpers; actors gain `id`/`label`.
- [x] 5.4 Rebuild `lineage.test.ts` setup on kernel models (`deriveLineageModel` over serialized
  documents) with every behavioural expectation — formatter strings, JSON shapes, search-tier
  resolution, truncation — unchanged; update the attestation names in `verify.test.ts` /
  `commands.test.ts` / `prov.test.ts`.
- [x] 5.3 Update `signing.test.ts` / `verify.test.ts` / `prov_bridge.test.ts` /
  `commands.test.ts` imports to the kernel names.

## 6. Verification

- [x] 6.1 `bun install`, `bun run typecheck`, `bun run lint`, `bun test`, `openspec validate
  adopt-prov-kernel --strict` — green (typecheck/test modulo the pre-existing published-harness
  drift on main, unchanged by this change).
