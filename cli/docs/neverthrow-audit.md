# neverthrow migration audit

> **Status: IMPLEMENTED.** All items below were migrated in commit `f4345b2` + follow-up fix. This file is now a reference for what was done and why.

Comprehensive catalog of every `try/catch`, `throw`, and error-handling site in `src/`.
Organized by verdict: what to convert, what to keep, and what stdlib calls need wrappers.

## 1. Already neverthrow-wrapped (no action needed)

These modules/functions already return `Result<T, E>` and use `tryQuery`/`tryMutation`/`Result.fromThrowable` to bridge throws.

| Layer / File | Functions | Notes |
|---|---|---|
| `db/util.ts` | `tryQuery`, `tryMutation`, `withTransaction` | The bridge layer — all legitimate try/catch wrapping bun:sqlite throws |
| `db/primary.ts` | `db()` | Connection bootstrap, wraps `new Database()` throws as `connection_failed` |
| `db/primary_migrations.ts` | `runMigrations` | Wraps DDL throws as `migration_failed` |
| `db/primary_query.ts` | All 18 query functions | Delegate to `tryQuery` — zero try/catch in this file |
| `db/primary_mutation.ts` | All 19 mutation functions | Delegate to `tryMutation` — zero try/catch in this file |
| `lib/config.ts` | `writeConfig` | Uses `Result.fromThrowable` for `mkdirSync`/`writeFileSync` |
| `modules/auth/auth.ts` | `loadAuth`, `saveAuth`, `deleteAuth`, `resolveAuth0Config`, `requestDeviceCode`, `pollForToken`, `refreshAccessToken`, `getValidAccessToken`, `revokeRefreshToken`, `tokenWireToStoredAuth`, `acquireRefreshLock` | Fully Result-based with `AuthError` union |
| `modules/anchor/anchor.ts` | `getOrCreateAnchorForCwd`, `resolveAnchor`, `classifyMarkerSighting`, `recoverAnchors` | Already return `Result<T, DbError>` |
| `modules/analysis/analysis.ts` | `createAnalysis`, `uniqueSlugForAnchor`, `listAnalysesForAnchorAt`, `matchAnalysis`, etc. | Already return `Result<T, DbError>` |
| `modules/analysis/input.ts` | `classifyInputPath`, `resolveInputPath` | Already return `Result<T, DbError>` |
| `modules/analysis/context.ts` | `resolveContext` | Returns `Result<ResolvedContext, DbError>` |
| `modules/intelligence/chat.ts` | `chat` | Returns `Promise<Result<void, DbError>>` |
| `modules/prov/signing.ts` | `loadOrGenerateKeypair` | Returns `Promise<Result<ImportedKeypair, SigningError>>` |
| `modules/prov/document.ts` | `serializeProvenance`, `findAnalysisForProv` | Return `Result<T, DbError>` |
| `modules/prov/verify.ts` | `buildSidecar` | Returns `Promise<Result<Sidecar, SigningError>>` |
| `modules/staging/staging.ts` | `stageInputs` | Returns `Promise<Result<StagedInput[], DbError \| StagingError>>` (was `Result<Promise<...>>`, restructured). **Downstream fork only** — this module does not exist in inf-cli yet. |

---

## 2. Functions that throw and SHOULD return `Result` (convert)

### Priority 1 — Root-cause throwers (converting these collapses downstream try/catch)

#### `modules/anchor/marker.ts`

| Function | Currently | Target | Downstream impact |
|---|---|---|---|
| `readMarker(dir)` | Returns `AnchorMarker \| null`, throws on corrupt marker & via `readFileSync` | `Result<AnchorMarker \| null, MarkerError>` | Collapses 7 try/catch blocks in `anchor.ts`, `backstop.ts`, `context.ts`, `analysis.ts`, `input.ts` |
| `writeMarker(dir, anchorId)` | Returns `AnchorMarker`, throws via `readMarker` + `mkdirSync` + `writeFileSync` | `Result<AnchorMarker, MarkerError>` | Collapses try/catch in `anchor.ts:60-63` |
| `findMarkerUpwards(startDir)` | Returns `{dir, marker} \| null`, throws via `readMarker` | `Result<{dir, marker} \| null, MarkerError>` | Collapses try/catch in `context.ts:50-55`, `analysis.ts:216-220`, `input.ts:33-36` |

**Stdlib calls needing wrappers inside `marker.ts`:** `readFileSync`, `mkdirSync`, `writeFileSync`

**Error type to define:**
```ts
type MarkerError =
    | { type: "marker_read_failed"; path: string; cause: unknown }
    | { type: "marker_corrupt"; path: string; raw: string }
    | { type: "marker_write_failed"; path: string; cause: unknown };
```

**Note:** `canonicalPath` (catches `realpathSync`, falls back to `resolve`) and `isDirWritable` (catches `accessSync`, returns boolean) are fine as-is — these are boolean/fallback predicates, not error channels. The `TODO(slop)` on `marker.ts:97` (`dirname`) is a false alarm — `dirname` is pure and never throws.

#### `modules/prov/signing.ts` — crypto primitives

| Function | Currently | Target |
|---|---|---|
| `signHexDigest(key, digest)` | `Promise<string>`, rejects via `crypto.subtle.sign` | `ResultAsync<string, SigningError>` |
| `computeChainHash(prev, json)` | `Promise<string>`, rejects via `crypto.subtle.digest` | `ResultAsync<string, SigningError>` |
| `computePayloadDigest(json)` | `Promise<string>`, rejects via `crypto.subtle.digest` | `ResultAsync<string, SigningError>` |
| `verifyHexDigest(key, digest, sig)` | `Promise<boolean>`, rejects via `crypto.subtle.verify` | `ResultAsync<boolean, SigningError>` |
| `exportPublicKeyJwk(kp)` | `Promise<JWK \| null>`, **uncaught** `crypto.subtle.exportKey` rejection | `ResultAsync<JWK \| null, SigningError>` |

Converting these removes the try/catch at `prov.ts:171-185` and fixes the **uncaught rejection** in `verify.ts:buildSidecar` (lines 166-170 call `computePayloadDigest`/`signHexDigest`/`exportPublicKeyJwk` without catch, bypassing the `Result` return type).

#### `lib/container.ts`

| Function | Currently | Target |
|---|---|---|
| `ensureReady(rt)` | `Promise<void>`, throws `ContainerRuntimeError` | `ResultAsync<void, ContainerRuntimeError>` |

Two well-defined failure modes (`not_found`, `not_ready`) that map to a discriminated union. Converting removes the 2 try/catch blocks in `proxy/setup.ts` (`setup:67-75`, `ensureProxyReadyOrExit:371-381`).

#### `lib/hash.ts`

| Function | Currently | Target |
|---|---|---|
| `sha256File(path)` | `Promise<string>`, rejects on stream error | `ResultAsync<string, HashError>` |

Callers (`staging.ts`, downstream fork only) currently have no try/catch — an I/O error is an unhandled rejection. Converting makes the failure visible.

#### `modules/intelligence/chat.ts`

| Function | Currently | Target |
|---|---|---|
| `readApiKey()` | `Promise<string>`, throws on missing key | `ResultAsync<string, ChatSetupError>` |
| `resolveModelId(apiKey)` | `Promise<string>`, throws on HTTP error / no models | `ResultAsync<string, ChatSetupError>` |

These throw inside the try/catch at `chat.ts:111-136`. Converting them would let the error channel stay in `Result` rather than flowing through `streamError`.

#### `modules/proxy/setup.ts`

| Function | Currently | Target |
|---|---|---|
| `resolveProvider(options)` | throws `ProxyError` on invalid provider | Return `Result<Provider \| undefined, ProxyError>` |
| `pullImage(rt, force)` | throws `ProxyError` on pull failure | Return `ResultAsync<void, ProxyError>` |
| `recreateContainer(rt)` | throws `ProxyError` on start failure | Return `ResultAsync<void, ProxyError>` |
| `ensureContainerRunning(rt)` | throws `ProxyError` on start failure | Return `ResultAsync<void, ProxyError>` |
| `ensureProxyReady()` | throws `ProxyError`/`ContainerRuntimeError` | Return `ResultAsync<void, ProxyError \| ContainerRuntimeError>` |

These are all internal to the `setup` command flow. `ensureProxyReady` is the public surface consumed by the TUI. Converting it removes the catch in `ensureProxyReadyOrExit` and makes the failure explicit in the type.

---

## 3. try/catch blocks that collapse once their throwing functions are converted

These are consumers of the throwing functions listed above. Once the source functions return `Result`, these try/catch blocks become `.andThen()`/`.map()`/`.match()` chains.

| File | Lines | Catches | Becomes |
|---|---|---|---|
| `anchor/anchor.ts` | 33-38 | `readMarker` throw → `err(query_failed)` | `readMarker(abs).andThen(...)` |
| `anchor/anchor.ts` | 60-63 | `writeMarker` throw → `err(mutation_failed)` | `writeMarker(abs, anchorId).andThen(...)` |
| `anchor/anchor.ts` | 74-78 | `readMarker` throw → `false` | `readMarker(dir).map(...).unwrapOr(false)` |
| `anchor/anchor.ts` | 87-93 | `findMarkerUpwards` throw → `null` | `findMarkerUpwards(startDir).map(...).unwrapOr(null)` |
| `anchor/backstop.ts` | 21-26 | `readMarker` throw → `null` | `readMarker(dir).unwrapOr(null)` |
| `anchor/backstop.ts` | 38-42 | `readMarker` throw → `fail()` | `readMarker(dir).match(ok, dieOn(...))` |
| `analysis/context.ts` | 50-55 | `findMarkerUpwards` throw → `err(query_failed)` | `findMarkerUpwards(cwd).mapErr(...)` |
| `analysis/analysis.ts` | 216-220 | `findMarkerUpwards` throw → `err(query_failed)` | `findMarkerUpwards(dir).mapErr(...)` |
| `analysis/input.ts` | 22-26 | `statSync` throw → `err(query_failed)` | `statResult(target).mapErr(...)` |
| `analysis/input.ts` | 33-36 | `findMarkerUpwards` throw → `err(query_failed)` | `findMarkerUpwards(abs).mapErr(...)` |
| `prov/prov.ts` | 171-185 | crypto primitives reject → log error | `signHexDigest(...).andThen(...)` |
| `proxy/setup.ts` | 36-75 | `ensureProxyReady` path → `process.exitCode=1` | `setup` returns `ResultAsync`, `.match()` at boundary |
| `proxy/setup.ts` | 371-381 | `ensureProxyReady` throw → `process.exit(1)` | `ensureProxyReady().match(...)` |
| `intelligence/chat.ts` | 111-136 | `readApiKey`/`resolveModelId` throw → `streamError` | `.andThen(...)` chain |

---

## 4. Legitimate try/catch (keep as-is)

These catch blocks are correct and should NOT be converted:

| File | Lines | Reason |
|---|---|---|
| `db/util.ts` | 8-12, 17-22, 31-52, 95-99 | Bridge layer: wraps bun:sqlite throws into `Result`. `TxAbort` throw-to-rollback. `ensureDir` best-effort. |
| `db/primary.ts` | 14-24 | Wraps `new Database()` constructor throws |
| `db/primary_migrations.ts` | 116-138 | Wraps DDL throws |
| `lib/config.ts` | 26-31 | Fail-closed to safe default on missing/corrupt config |
| `lib/log.ts` | 17-28, 33-36, 89-93 | Log infrastructure — must never crash the app |
| `lib/otel.ts` | 51-74, 87-108 | Telemetry — must never crash the app |
| `lib/clipboard.ts` | 50-57 | Best-effort clipboard write, logged |
| `index.ts` | 41-68 | Process entry point — Commander uses throw-based control flow |
| `extensions/json.ext.ts` | 16-22 | Global extension absorbs `JSON.parse` throws into `T\|null` |
| `extensions/response.ext.ts` | 18-24 | Global extension absorbs `Response.json()` throws into `T\|null` |
| `tui/grammars/register.ts` | 67-88 | Fire-and-forget grammar warming |
| `tui/commands.tsx` | 264-270, 381-385, 409-414 | Dynamic `import()` is inherently throwing |
| `analysis/lock.ts` | 30-35, 45-50, 65-75, 90-100 | Advisory lock: PID-probe + O_EXCL are throw-based by design, fail-open semantics. `LockOutcome` is intentionally not `Result`. |
| `auth/auth.ts` | 147-152, 185-193, 225-241, 279-287, 323-333, 338-345, 381-388, 408-412, 423-427 | Bridging `fetch`/`readFileSync`/`writeFileSync`/`statSync` throws into `Result<T, AuthError>` |
| `prov/export.ts` | 28-31, 49-55 | CLI action — `fail()` / best-effort sidecar write |
| `prov/verify.ts` | 213-216, 219-222 | Bridging `crypto.subtle.importKey` + `readFileSync` into `VerifyResult` status |
| `prov/signing.ts` | 67-71, 85-115, 131-137, 140-160, 171-175 | Bridging FS + WebCrypto into `Result<T, SigningError>` (except the crypto primitives — see §2) |
| `staging/staging.ts` | 49-53 | Hardlink fallback to copy — catch is the intentional fallback, not an error (**downstream fork only**) |

---

## 5. Legitimate throw (keep as-is, pre-approved by policy)

| File | Line | What | Justification |
|---|---|---|---|
| `lib/env.ts` | 88, 92 | Crash on misconfigured build | Invariant assertion — silently stamping provenance with garbage is worse |
| `prov/document.ts` | 67 | Exhaustive-switch default (`never`-branch) | Compiler bug guard |
| `tui/contexts/workspace.ts` | 105 | Context provider missing | React/Solid framework convention — programmer bug |
| `db/util.ts` | 43 | `TxAbort` throw-to-rollback | Internal bridge, never escapes `withTransaction` |
| `prov/signing.ts` | 94, 104 | Re-throw non-EEXIST `linkSync` errors | Propagates to outer catch that wraps in `Result` |
| `lib/cli.ts` | `fail()`, `dieOn()` | CLI boundary exit (`never` return) | Top-level bail-out, the process is terminating |

---

## 6. Stdlib wrappers needed

Functions the codebase calls that throw, needing `Result`-returning wrappers:

| Stdlib function | Where called (unwrapped) | Wrapper location |
|---|---|---|
| `readFileSync(path, "utf8")` | `marker.ts:46` | `lib/fs.ts` (new: `readFileResult`) |
| `writeFileSync(path, data, opts?)` | `marker.ts:67`, `commands.tsx:295,309` | `lib/fs.ts` (`writeFileResult`) |
| `mkdirSync(path, opts?)` | `marker.ts:66`, `commands.tsx:294` | `lib/fs.ts` (`mkdirResult`) |
| `statSync(path)` | `input.ts:23` | `lib/fs.ts` (`statResult`) |
| `crypto.subtle.sign(...)` | `signing.ts:239` | wrap inline with `ResultAsync.fromPromise` |
| `crypto.subtle.verify(...)` | `signing.ts:248` | wrap inline with `ResultAsync.fromPromise` |
| `crypto.subtle.digest(...)` | `signing.ts:210,223,229` | wrap inline with `ResultAsync.fromPromise` |
| `crypto.subtle.exportKey(...)` | `signing.ts:185` | wrap inline with `ResultAsync.fromPromise` |
| `createReadStream` (via reject) | `hash.ts:12` | wrap `sha256File` itself |

**Note:** `JSON.parse` is already wrapped by `JSON.parseWith` (extension). `readFileSync`/`writeFileSync` in `auth.ts` and `config.ts` are already bridged into `Result` at their call sites — but a shared `lib/fs.ts` wrapper would DRY those.

---

## 7. TODO(slop) tags — all 13

| File | Line | Tag text | Action |
|---|---|---|---|
| `anchor/marker.ts` | 19 | `neverthrow` (on `canonicalPath`'s `realpathSync` catch) | Keep as-is — fallback predicate, not an error channel |
| `anchor/marker.ts` | 46 | `make a wrapper that returns result` (on `readFileSync`) | Convert `readMarker` to return `Result` |
| `anchor/marker.ts` | 51 | `don't throw, return result` (on corrupt marker throw) | Convert to `err({ type: "marker_corrupt" })` |
| `anchor/marker.ts` | 66 | `Make wrapper - don't throw` (on `mkdirSync`) | Use `mkdirResult` wrapper |
| `anchor/marker.ts` | 67 | `make wrapper - don't throw` (on `writeFileSync`) | Use `writeFileResult` wrapper |
| `anchor/marker.ts` | 78 | `neverthrow` (on `isDirWritable`'s `accessSync` catch) | Keep as-is — boolean predicate, not an error channel |
| `anchor/marker.ts` | 97 | `make a wrapper that returns result` (on `dirname`) | Remove — `dirname` is pure and never throws |
| `anchor/anchor.ts` | 61 | `this will be refactored to return result` (on `writeMarker` catch) | Collapses once `writeMarker` returns `Result` |
| `anchor/anchor.ts` | 75 | `same here, try catch without reason` (on `readMarker` catch) | Collapses once `readMarker` returns `Result` |
| `anchor/anchor.ts` | 88 | `neverthrow` (on `findMarkerUpwards` catch) | Collapses once `findMarkerUpwards` returns `Result` |
| `anchor/backstop.ts` | 22 | `neverthrow` (on `readMarkerSafe`'s `readMarker` catch) | Collapses once `readMarker` returns `Result` |
| `anchor/backstop.ts` | 39 | `neverthrow` (on `runRepair`'s `readMarker` catch) | Collapses once `readMarker` returns `Result` |
| `analysis/context.ts` | 51 | `neverthrow` (on `findMarkerUpwards` catch) | Collapses once `findMarkerUpwards` returns `Result` |

---

## 8. Uncaught rejection bugs (fix during migration)

| File | Lines | Bug | Fix |
|---|---|---|---|
| `prov/verify.ts` | 166-170 (`buildSidecar`) | Calls `exportPublicKeyJwk`, `computePayloadDigest`, `signHexDigest` without try/catch. These can reject, bypassing `buildSidecar`'s `Result` return. | Convert the 3 functions to `ResultAsync` (§2), then chain with `.andThen` |
| `prov/document.ts` | 88 | `ProvDocument.deserialize(storedJson)` can throw on corrupt stored JSON. Propagates uncaught through `prov.ts`'s recorder. | Wrap in `Result.fromThrowable` at the call site |

---

## 9. Suggested migration order

1. **`lib/fs.ts`** — create `readFileResult`, `writeFileResult`, `mkdirResult`, `statResult` wrappers using `Result.fromThrowable`
2. **`modules/anchor/marker.ts`** — convert `readMarker`, `writeMarker`, `findMarkerUpwards` to return `Result<T, MarkerError>`; remove 3 TODO(slop) tags; update `marker.test.ts`
3. **`modules/anchor/anchor.ts`** — replace 4 try/catch blocks with `.andThen()`/`.unwrapOr()`; remove 3 TODO(slop) tags
4. **`modules/anchor/backstop.ts`** — replace 2 try/catch blocks with `.match()`; remove 2 TODO(slop) tags
5. **Downstream consumers** — `analysis/context.ts`, `analysis/analysis.ts`, `analysis/input.ts` — replace try/catch with `.andThen()`; remove 1 TODO(slop) tag
6. **`modules/prov/signing.ts`** — convert 5 crypto primitives to `ResultAsync`
7. **`modules/prov/prov.ts`** + **`modules/prov/verify.ts`** — replace try/catch with `.andThen()`, fix uncaught rejections
8. **`lib/container.ts`** — convert `ensureReady` to `ResultAsync`
9. **`modules/proxy/setup.ts`** — convert internal functions + `ensureProxyReady` to `ResultAsync`
10. **`modules/intelligence/chat.ts`** — convert `readApiKey`, `resolveModelId` to `ResultAsync`
11. **`lib/hash.ts`** — convert `sha256File` to `ResultAsync`
12. **`tui/commands.tsx`** — replace `mkdirSync`/`writeFileSync` try/catch with wrappers

---

## 10. Uncaught throws inside `Result` `.map()` chains (will bypass the error channel)

These are calls to throwing stdlib functions inside `.map()`/`.andThen()` callbacks that do NOT have their own try/catch. If they throw, the exception bypasses the `Result` error channel entirely, becoming an unhandled exception/rejection.

| File | Function | Line | Throwing call | Risk |
|---|---|---|---|---|
| `analysis/output.ts` | `ensureOutputDir` | 45 | `mkdirSync` inside `.map()` | Permission denied blows up past `DbError` |
| `analysis/open.ts` | `openOutputDir` | 33 | `Bun.spawn` inside `.map()` | Missing opener binary blows up |
| `staging/staging.ts` | `stageFile` | 48 | `mkdirSync` | Permission denied (**downstream fork only**) |
| `staging/staging.ts` | `stageFile` | 52 | `copyFileSync` (fallback after `linkSync` catch) | Cross-fs + copy failure (**downstream fork only**) |
| `staging/staging.ts` | `stageSingleFile` | 84 | `statSync` | File vanished between stage and stat (**downstream fork only**) |
| `staging/staging.ts` | `walkFiles` | 63 | `readdirSync` | Permission denied (**downstream fork only**) |
| `staging/staging.ts` | `stageSingleFile` | 83 | `sha256File` | Async rejection inside Promise (**downstream fork only**) |

**Staging structural gap (downstream fork only — module does not exist in inf-cli yet):** `stageInputs` returns `Result<Promise<StagedInput[]>, DbError>` — the DB-read phase is Result-wrapped, but the entire filesystem I/O phase runs inside the unwrapped `Promise`. Any FS error during staging becomes an unhandled rejection rather than flowing through Result. The fix is to change the return type to `ResultAsync<StagedInput[], DbError | StagingError>` so the I/O phase is also Result-wrapped.
