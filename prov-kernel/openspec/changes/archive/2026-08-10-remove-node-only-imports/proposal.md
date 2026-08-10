# Remove the node-only imports

## Why

`src/document.ts` imported `createHash` and `randomUUID` from `node:crypto`.
A browser bundler cannot resolve a `node:`-prefixed module. Thus a browser
consumer could not bundle the package, and the load failed at build time.
The kernel serves browser and server hosts alike, and both must resolve
every module.

## What Changes

- Back the digest with the synchronous SHA-256 from the audited
  `@noble/hashes` package, byte-identical to `createHash("sha256")` from
  `node:crypto`. `defaultProvDigest` folds that digest as before, thus
  every derived identifier stays the same.
- The default action-id minter calls `globalThis.crypto.randomUUID`, which
  browsers and Node.js both give.
- Add `src/sha256.test.ts`: byte-equality against `node:crypto` over the
  empty input, ascii, multi-byte UTF-8, each block boundary, and a 4KiB
  input.
- Add `src/browser-safety.test.ts`: a guard that reads the built
  `dist/*.js` modules and fails on a `node:`-prefixed specifier.
- Declare `"sideEffects": false` in `package.json`, so a consumer bundler
  can tree-shake the modules that a page does not use.
- Bump the package version from 0.5.0 to 0.5.1.

## Capabilities

### Modified Capabilities

- `prov-kernel`: a new requirement makes the browser-safety of the modules
  explicit. The wire format and every derivation stay the same.

## Impact

- `src/document.ts`, `src/sha256.test.ts` (new),
  `src/browser-safety.test.ts` (new), `package.json`, `README.md`,
  `CLAUDE.md`.
- Not breaking: the golden fixture stays byte-identical, and the public
  API does not change.
