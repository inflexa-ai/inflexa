## 1. Scaffold the package

- [x] 1.1 Create `prov-kernel/` with `package.json` (`@inflexa-ai/prov-kernel` 0.1.0, deps
  `@inflexa-ai/tsprov` + `neverthrow` + `zod` only, same
  engines/exports/files/publishConfig shape as `harness/package.json`),
  `tsconfig.json`, `tsconfig.eslint.json`, `eslint.config.js` with the
  neverthrow patch, `patches/`, `.prettierrc`, `LICENSE`, `NOTICE`.
- [x] 1.2 Add `"types": ["node"]` to the build tsconfig and
  `["node", "bun"]` to the lint tsconfig — TS 6 no longer auto-includes
  `node_modules/@types`, and the kernel has no dependency that references
  them transitively.
- [x] 1.3 Run `bun install` and commit `bun.lock` (CI installs with
  `--frozen-lockfile`).

## 2. Write the kernel sources

- [x] 2.1 Write `types.ts` with no event union: `ProvActor`,
  `ProvModelId`, `ProvSubject`, the input/run/step/file/command refs, the
  outcomes, `ProvFileKey`, and `VerifyResult`.
- [x] 2.2 Write `document.ts`: `createProvDocumentModel`,
  `PROV_UNIFY_OPTIONS`, `defaultProvDigest`, and every QName and relation-id
  derivation.
- [x] 2.3 Write `signing.ts`: `ProvSigner`, `ProvSigningError`,
  `createKeypairSigner`, `computeChainHash`, `computePayloadDigest`,
  `signHexDigest`, `verifyHexDigest`, `ProvPublicKeyJwk`.
- [x] 2.4 Write `verify.ts`: `verifyProvenance`, `verifyPayload`,
  `buildSidecar`, `verifySidecar`, `sidecarSchema`, `formatVerifyResult`.
- [x] 2.5 Add the `src/index.ts` barrel with the public surface.

## 3. Tests

- [x] 3.1 QName determinism and the injected digest: a custom digest
  re-derives every digest-bearing QName consistently; the same input derives
  the same QName.
- [x] 3.2 Builders: one run's statements produce the expected
  activity/entity/agent/relation keys; a double build dedupes under
  `unified()` with `PROV_UNIFY_OPTIONS` (one entity per file key, one
  generation edge under its deterministic id); no relation id starts with
  `_:`.
- [x] 3.3 Signing: the chain seed and the chain step against independent
  SHA-256 computations; an Ed25519 sign/verify roundtrip; tamper detection.
- [x] 3.4 Verify and sidecar: `buildSidecar` output parses under
  `sidecarSchema` and verifies; a modified payload reads tampered;
  `verifyProvenance` is valid on a correct link and fails on a wrong prev or
  a wrong signature.
- [x] 3.5 Golden fixture: a fully deterministic document (fixed ids, fixed
  epoch-ms times, default digest) serializes to
  `src/__fixtures__/golden-document.json`. No `Date.now()` anywhere in the
  tests.

## 4. Documents

- [x] 4.1 Write `SPEC.md`: namespace, digest, QName formats, relation-id
  schemes, chain rule, signatures and encodings, sidecar shape, unify
  semantics, and the digest-injectability note — all derived from the code.
- [x] 4.2 Write `README.md` (the package and the three-layer rule) and
  `CLAUDE.md` (modeled on `harness/CLAUDE.md`), with the `AGENTS.md` symlink.
- [x] 4.3 Write `scripts/smoke.mjs`: load `dist/`, derive one QName, run one
  sign/verify roundtrip.

## 5. Verify

- [x] 5.1 `bun run typecheck`.
- [x] 5.2 `bun run lint`.
- [x] 5.3 `bun test`.
- [x] 5.4 `bun run build && node scripts/smoke.mjs`.
- [x] 5.5 `bun run format:file` on every touched file under `src/`.
