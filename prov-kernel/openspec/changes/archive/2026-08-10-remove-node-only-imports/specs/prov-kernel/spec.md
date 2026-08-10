## ADDED Requirements

### Requirement: The kernel loads in browser and server runtimes

Every module in the package SHALL resolve with no `node:`-prefixed import,
so a browser bundler can bundle the barrel and every subpath. The default
digest SHALL compute SHA-256 with the synchronous implementation from the
audited `@noble/hashes` package, byte-identical to `createHash("sha256")`
from `node:crypto`. The default action-id minter and the signature
primitives SHALL reach the Web Crypto API through `globalThis.crypto`. A
guard test SHALL read the built `dist/*.js` modules and fail when a module
names a `node:`-prefixed specifier.

#### Scenario: A browser bundler resolves the package

- **GIVEN** a browser application that imports the package barrel
- **WHEN** the bundler resolves the import graph of `dist/`
- **THEN** no `node:`-prefixed specifier appears, and the bundle builds

#### Scenario: The noble-backed digest matches node:crypto

- **GIVEN** the empty input, an ascii string, a multi-byte UTF-8 string,
  each block boundary, and an input above 1KiB
- **WHEN** the `@noble/hashes` SHA-256 and `createHash("sha256")` digest
  the same input
- **THEN** the two digests are byte-identical, and `defaultProvDigest`
  derives the same base36 fold as before

#### Scenario: A node-only import fails the suite

- **GIVEN** a change that adds a `node:`-prefixed import to a module in
  `src/`
- **WHEN** the build emits `dist/` and the test suite runs
- **THEN** the browser-safety guard fails before the package publishes
