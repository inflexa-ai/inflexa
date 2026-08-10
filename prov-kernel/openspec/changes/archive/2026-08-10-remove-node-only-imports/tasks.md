## 1. Remove the node-only imports

- [x] 1.1 `src/sha256.ts`: vendor a synchronous SHA-256 (FIPS 180-4) in
  one internal module.
- [x] 1.2 `src/document.ts`: `defaultProvDigest` folds the vendored
  digest. The default action-id minter calls
  `globalThis.crypto.randomUUID`. Remove the `node:crypto` import.
- [x] 1.3 `package.json`: declare `"sideEffects": false`.

## 2. Tests

- [x] 2.1 `src/sha256.test.ts`: byte-equality against `node:crypto` over
  the empty input, ascii, multi-byte UTF-8, each block boundary, and a
  4KiB input. `defaultProvDigest` matches the former derivation over
  different identity strings.
- [x] 2.2 `src/browser-safety.test.ts`: read the built `dist/*.js`
  modules and fail on a `node:`-prefixed specifier.

## 3. Documents and version

- [x] 3.1 `README.md` and `CLAUDE.md`: state the browser and server
  runtimes.
- [x] 3.2 Bump `package.json` to 0.5.1.
- [x] 3.3 `bun install --frozen-lockfile`, `bun run typecheck`,
  `bun run lint`, `bun test` (the golden fixture stays byte-identical),
  `bun run build && bun run smoke`, `openspec validate --all --strict`.
- [x] 3.4 `bun run format:file` on every touched file under `src/`.
