# Proposal

## Why

An install receipt holds `activatedAt`. Thus two installs of the same dataset version with the same bytes give two different receipt files. Some consumers pin a reference store with a digest over the receipt files, for example the bench. Such a consumer sees a change where the data is the same (issue #651).

## What Changes

- **BREAKING**: The receipt contract gets a required `contentDigest` field. The value is a SHA-256 digest over a canonical form of the dataset identity and the artifacts. The artifact fields are the path, the size, and the digest. The install time does not enter it.
- **BREAKING**: `REFERENCE_INSTALL_RECEIPT_VERSION` goes from 1 to 2. A version 1 receipt is invalid. A new download of the dataset writes a version 2 receipt.
- The parse rejects a receipt whose `contentDigest` does not agree with its fields.
- The harness exports the function that calculates the digest, so each embedder writes the same value.
- The CLI installer writes `contentDigest` into each receipt.
- `activatedAt` stays in the receipt, and `inflexa refs list --json` keeps `installedAt`.

Out of scope:

- An expected SHA-256 in the catalog. The `reference-data-catalog` spec rejects a checked-in digest on purpose.
- The bench change that reads `contentDigest`.
- The package-store receipt of `cli/src/modules/libs/store_download.ts`.

## Capabilities

### New Capabilities

### Modified Capabilities

- `reference-data-catalog`: the receipt contract adds a content identity that is independent of the install time.

## Impact

- `harness/src/reference-data/receipt.ts`: the schema, the version, and the digest function.
- `harness/src/index.ts`: the export of the digest function.
- `cli/src/modules/refs/store.ts`: the receipt writer.
- The fixtures of the tests that build a receipt, in the harness and in the CLI.
- Each receipt on disk that a build before this change wrote reads as invalid until a new download.
