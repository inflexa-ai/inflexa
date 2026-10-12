# Tasks

## 1. Harness receipt contract

- [x] 1.1 In `harness/src/reference-data/receipt.ts`, set `REFERENCE_INSTALL_RECEIPT_VERSION` to 2, and add a function that calculates the content digest from the dataset id, the dataset version, and the artifacts. Make sure that a unit test in `catalog.test.ts` gives the same digest for a different `activatedAt` and for a different artifact order.
- [x] 1.2 Add a required `contentDigest` field to `ReferenceInstallReceiptSchema`, and reject a receipt whose digest does not agree with its fields. Make sure that the receipt tests in `catalog.test.ts` accept a correct digest and reject a wrong digest and a version 1 receipt.
- [x] 1.3 Export the digest function from `harness/src/index.ts`. Make sure that `tsc -p tsconfig.build.json` passes.
- [x] 1.4 Update the receipt fixtures of `list-available-refs.test.ts`. Make sure that `bun test src/reference-data src/tools/sandbox/list-available-refs.test.ts` passes.

## 2. CLI receipt writer

- [x] 2.1 Link the working-copy harness into the CLI with `bun run harness:local`. Make sure that the CLI typecheck resolves the new export.
- [x] 2.2 In `cli/src/modules/refs/store.ts`, write `contentDigest` into the receipt that `installDataset` makes. Make sure that a test in `store.test.ts` installs the same bytes into two store roots at different clock times. The two receipts must have different `activatedAt` values and the same `contentDigest`.
- [x] 2.3 Update the receipt fixtures of `store.test.ts` and `commands.test.ts`. Make sure that `bun test src/modules/refs` and `bun run typecheck` pass in `cli/`.
