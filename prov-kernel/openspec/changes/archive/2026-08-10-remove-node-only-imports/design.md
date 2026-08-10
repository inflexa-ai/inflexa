## Context

The kernel is the format authority for browser and server hosts. A lineage
viewer runs in a browser, and its bundler must resolve every import of the
package. `node:crypto` gave the kernel two things: a synchronous SHA-256
for `defaultProvDigest`, and `randomUUID` for the default action-id minter.
A browser bundler resolves neither.

## Goals / Non-Goals

Goals:

- No `node:`-prefixed import in any built module.
- Every derived identifier stays byte-identical.
- A guard that fails the test suite when a node-only import returns.

Non-Goals:

- No change to the wire format, the digest derivation, or the signature
  scheme.

## Decisions

### The `@noble/hashes` synchronous SHA-256

The Web Crypto API gives only an asynchronous digest, but the `ProvDigest`
contract is synchronous. The audited `@noble/hashes` package gives a
synchronous SHA-256 in pure JavaScript, with no `node:` import. Thus the
runtime-dependency policy of the package grows to tsprov, zod, neverthrow,
and `@noble/hashes`. `sha256.test.ts` proves byte-equality against
`node:crypto` over inputs that cover the block-padding boundaries. The
golden fixture pins the derived bytes as before.

### `globalThis.crypto.randomUUID` replaces `randomUUID`

The signature primitives already reach the Web Crypto API through the
`crypto` global. The default action-id minter now uses the same global,
which browsers and Node.js both give. The minter stays injectable, thus a
host with a different id policy overrides it.

### A dist-level guard, not a source-level rule

The guard reads the built `dist/*.js` modules, thus it sees exactly the
specifiers that a bundler sees. The pattern matches only an import
position, because a kept comment can name `node:crypto` in prose.

### `"sideEffects": false`

Each module defines functions, constants, and schemas, and none runs an
effect at load time. The flag lets a consumer bundler tree-shake the
modules that a page does not use. The primary fix stays the removal of
`node:crypto` — a bundler must not depend on tree-shake support for a
correct build.
