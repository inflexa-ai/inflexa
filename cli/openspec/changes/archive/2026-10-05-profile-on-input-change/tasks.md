## 1. Enumeration drops the drift signature

- [x] 1.1 Replace `enumerateInputSignatures` with `enumerateInputPaths` (analysis-relative paths, same walk, same skips)
- [x] 1.2 Delete `inputSignature` and `inputSignatureDigest`
- [x] 1.3 Re-point the mtime-precision rationale at `isInputSetMaterialized`, which still compares size + mtime

## 2. The ladder branches on cause, not on a comparison

- [x] 2.1 Delete `isProfiledAtParity` and `inputSetMatches`
- [x] 2.2 Add `ProfileDriveCause`; share one ladder behind `ensureProfileAtParity` ("open") and `reprofileForInputChange` ("inputs_changed")
- [x] 2.3 A completed row on an open drive materializes if the tree is behind, then reports `already_profiled`
- [x] 2.4 A failed row's `skipped_failed` short-circuit applies to the open drive only

## 3. Wire the edges

- [x] 3.1 `ParityDriverSeams` gains `reprofile`; `driveProfileParity` takes the cause
- [x] 3.2 Edges 1 and 3 (boot/swap, run settled) drive as `"open"`; edge 2 (input mutation) as `"inputs_changed"`
- [x] 3.3 `inflexa inputs add`/`remove` name `inflexa profile` after a successful mutation

## 4. Tests

- [x] 4.1 Staging: enumeration asserts against staged `relativePath`s; the signature-encoder tests go
- [x] 4.2 Ladder: a completed row is left alone on open (including an in-place rewrite), re-profiled on input change
- [x] 4.3 Ladder: a failed row is skipped on open, retried on input change
- [x] 4.4 Watch: the input edge drives `"inputs_changed"`, the boot edge `"open"`
