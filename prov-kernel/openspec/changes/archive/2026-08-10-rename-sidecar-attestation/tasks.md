## 1. Rename the surface

- [x] 1.1 `src/verify.ts`: `buildSidecar` → `buildAttestation`,
  `verifySidecar` → `verifyAttestation`, `sidecarSchema` →
  `attestationSchema`, type `Sidecar` → `ProvAttestation`; doc comments
  follow. The schema fields do not change.
- [x] 1.2 `src/types.ts`: the `VerifyResult` status `invalid-sidecar` →
  `invalid-attestation`; `src/verify.ts` renders the renamed status.
- [x] 1.3 `src/index.ts` re-exports the new names. `src/signing.ts` doc
  comments follow.
- [x] 1.4 `src/verify.test.ts` renames its identifiers and descriptions.

## 2. Documents

- [x] 2.1 `SPEC.md`: rename "The sidecar" to "The attestation", with one line
  that gives the former name, and rename the remaining prose mentions.
- [x] 2.2 `README.md`, `CLAUDE.md`, and `scripts/smoke.mjs` follow.

## 3. Version and verify

- [x] 3.1 Bump `package.json` to 0.4.0 (shared with the
  add-lineage-read-model change).
- [x] 3.2 `bun install --frozen-lockfile`, `bun run typecheck`,
  `bun run lint`, `bun test` (the golden fixture stays byte-identical),
  `bun run build && bun run smoke`, `openspec validate --all --strict`.
- [x] 3.3 `bun run format:file` on every touched file under `src/`.
