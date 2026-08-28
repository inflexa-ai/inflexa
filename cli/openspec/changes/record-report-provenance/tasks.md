# Tasks — record-report-provenance

## 1. The kernel pin and the types

- [x] 1.1 Move the `@inflexa-ai/prov-kernel` pin to `^0.6.0`
- [x] 1.2 Replace the cli-owned report ref types in `src/types/prov.ts` with kernel re-exports
- [x] 1.3 Add `blockKind` to the four block members in `src/types/events.ts`, and to their `eventFields` projection in `src/lib/bus.ts`

## 2. The uniform recorder

- [x] 2.1 Extend `toKernelEvent` with the nine report members
- [x] 2.2 Delete the host mapping from `src/modules/prov/prov.ts`: `isReportEvent`, `appendReportRecords`, and the helper set
- [x] 2.3 Point the recorder fixture tests at the kernel arms, and keep the flushed-document assertions unchanged
- [x] 2.4 Cover the double-emit guard on the flushed document state

## 3. The merged bridge

- [x] 3.1 Fold `report_bridge.ts` into `src/modules/harness/prov_bridge.ts`, with the session emit, the live-model source, and trimmed comments
- [x] 3.2 Carry `blockKind` through the session emit mapping
- [x] 3.3 Move the read realization into the merged bridge, unchanged in behavior
- [x] 3.4 Bind one `ProvenanceSeam` object on the core bag in `src/modules/harness/runtime.ts`, and pass it into `PrepareChatTurnDeps`
- [x] 3.5 Update the bridge tests to the merged module, absence included

## 4. Verification

- [x] 4.1 Run `bun run typecheck`, and run the targeted test files of each changed area
- [x] 4.2 Run `bun run format:file` on each changed source file
