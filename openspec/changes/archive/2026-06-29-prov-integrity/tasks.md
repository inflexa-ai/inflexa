## 1. Infrastructure — keypair and env

- [x] 1.1 Add `provKeyPath` to `env` in `src/lib/env.ts` (`<configDir>/inflexa/prov_key.json`) and to `envDoc` for `--help`
- [x] 1.2 Create `src/modules/prov/signing.ts` — keypair generation (`crypto.subtle.generateKey("Ed25519")`), load-or-generate lifecycle, JWK file read/write, sign and verify functions over raw bytes
- [x] 1.3 Write tests for signing: keypair round-trip (generate → export → import → sign → verify), tampered data fails verification, missing key file returns null gracefully

## 2. DB schema — integrity columns

- [x] 2.1 Add migration v3 to `src/db/primary_migrations.ts`: `ALTER TABLE analyses ADD COLUMN provenance_chain_hash TEXT; ALTER TABLE analyses ADD COLUMN provenance_signature TEXT;`
- [x] 2.2 Add `getAnalysisIntegrity(id)` to `src/db/primary_query.ts` returning `{ chainHash: string | null, signature: string | null }`
- [x] 2.3 Extend `updateAnalysisProvenance` in `src/db/primary_mutation.ts` to accept optional `chainHash` and `signature`, writing all three columns in one `UPDATE`
- [x] 2.4 Update `src/db/primary_migrations.test.ts` to assert the new columns exist after migration v3

## 3. Chain computation — hash and sign at flush

- [x] 3.1 Create chain hash function in `src/modules/prov/signing.ts`: `computeChainHash(prevChainHashHex: string | null, provJson: string): Promise<string>` — returns hex-encoded `SHA-256(prevBytes || provJsonBytes)` with `SHA-256("")` as the seed when prev is null
- [x] 3.2 Wire chain hash + sign into `flushProvenance()` in `src/modules/prov/prov.ts`: after `doc.unified().serialize("json")`, compute chain hash from stored prev + new JSON, sign it, pass all three to `updateAnalysisProvenance`
- [x] 3.3 Handle missing keypair gracefully in flush: if signing fails or keypair is absent, still write `provenance` but leave integrity columns `NULL`, log a warning
- [x] 3.4 Write integration test: emit bus events → flush → read back integrity columns → verify signature matches chain hash of stored PROV-JSON

## 4. Verification command

- [x] 4.1 Define `VerifyResult` type in `src/types/prov.ts`: discriminated union with `valid | unsigned | tampered | no-key | empty`
- [x] 4.2 Create `src/modules/prov/verify.ts` — pure `verifyProvenance(provJson, chainHash, signature, publicKey)` function returning `VerifyResult`, plus the CLI action `runVerifyProvenance(ref)` that loads inputs from DB and calls it
- [x] 4.3 Write unit tests for `verifyProvenance`: all five result variants (valid, unsigned, tampered, no-key, empty)
- [x] 4.4 Register `prov verify <analysis>` in `src/cli/index.ts` under the existing `prov` command group, lazy-importing `verify.ts`

## 5. TUI integration

- [x] 5.1 Add "Verify provenance" command to `src/tui/commands.tsx` (`id: "prov.verify"`, category "Analysis", enabled when analysis is open), lazy-importing verify module, displaying result as notice
- [x] 5.2 Test manually: open TUI, run verify from palette, confirm notice shows for valid/unsigned/empty states

## 6. Export — verification bundle

- [x] 6.1 Extend `src/modules/prov/export.ts` to write a sidecar `.sig.json` file alongside the provenance document when a signature is stored and the public key is available
- [x] 6.2 Extend the TUI `exportProvenanceToFile` in `src/tui/commands.tsx` to write the sidecar alongside the provenance file
- [x] 6.3 Write test: export with signed provenance produces both `.json` and `.json.sig.json`; export without signature produces only `.json`

## 7. Cleanup and format

- [x] 7.1 Run `bun run typecheck` and `bun run lint` — fix any issues
- [x] 7.2 Run `bun run format:file` on all changed `src/` files
- [x] 7.3 Run full test suite (`bun test`) — all tests pass
