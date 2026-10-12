# Design

## Context

The harness owns the receipt contract (`harness/src/reference-data/receipt.ts`). The CLI writes the receipt (`cli/src/modules/refs/store.ts`, `installDataset`). The harness tool `list_available_refs` reads it. The bench reads the receipt files with no dependency on the harness.

## Goals / Non-Goals

**Goals:**

- One content identity for each set of installed bytes, readable from the receipt JSON alone.

**Non-Goals:**

- A change of the receipt file bytes for the same content. The file keeps `activatedAt`.

## Decisions

- **A stored field, not a derived value.** The bench has no harness dependency. Thus the identity must be in the JSON. A harness-only function would make each consumer copy the algorithm.
- **A canonical JSON array as the hash input.** `JSON.stringify([datasetId, datasetVersion, [[path, bytes, sha256], ...]])` has no key-order question and no separator question. A consumer in a different language can make the same bytes with its standard JSON library in compact mode.
- **Sort by path.** The receipt keeps artifacts in catalog order. A sort makes the identity independent of a change of catalog order.
- **The parse checks the digest.** A receipt with a wrong digest is invalid, as a receipt with a duplicate path is invalid now. Thus a consumer that trusts a valid receipt can trust its digest.
- **The version goes to 2.** The contract adds a required field. A version 1 receipt has no digest and fails the parse. The new version number makes that failure explicit.

## Risks / Trade-offs

- [Each receipt on disk becomes invalid] → The CLI shows the dataset as an invalid receipt, and `inflexa refs download` repairs it with the normal install path.
- [Code-unit order and code-point order differ for a character outside the Basic Multilingual Plane] → The catalog paths are ASCII, thus the two orders agree.

## Migration Plan

No data migration. A new download writes a version 2 receipt.
