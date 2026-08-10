## Context

The export verification object entered the kernel as the "sidecar", after the
CLI's `.sig.json` file that travels next to an exported document. The name
described the CLI's transport, not the object. A managed host stores the same
object in a column; nothing there is a sidecar.

## Goals / Non-Goals

Goals:

- One name, "attestation", across the API, the docs, the tests, and the wire
  contract document.
- Zero effect on existing artifacts.

Non-Goals:

- No shape change, no field rename, no verification change.
- No deprecated aliases.

## Decisions

### The JSON payload is untouched

No field of the object contains the word "sidecar" — the fields are
`payloadType`, `payloadDigestAlgorithm`, `payloadDigest`,
`payloadDigestMethod`, `signatureAlgorithm`, `signature`, `publicKey`, and
`kid`. Thus the rename touches only code identifiers and prose, and every
artifact written under the old name parses and verifies unchanged. The golden
fixture and the signature scheme do not move.

### A clean rename, no aliases

The package is 0.x and every consumer is an in-flight pull request we control.
A deprecation window would carry two names through reviews for no reader's
benefit. The old names are removed in the same change that adds the new ones.

### The `invalid-sidecar` status renames too

The `VerifyResult` status value is API, not wire: it is a returned value a
host branches on, never a serialized artifact field. A clean rename that keeps
one API value on the old name would leave the confusion in the one place a
consumer matches on strings.

### `SPEC.md` keeps one line of history

The wire contract is a public document, and artifacts exist in the wild that
their producers documented as "sidecars". The renamed section keeps one line
that gives the former name, so a reader who holds an old artifact finds the
contract. This is the one permitted history note; code comments carry none.
