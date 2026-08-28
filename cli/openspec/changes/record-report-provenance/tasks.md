# Tasks — record-report-provenance

## 1. The types and the bus

- [x] 1.1 Add the report ref shapes to `src/types/prov.ts`, as cli-owned types
- [x] 1.2 Add the nine report members to the `BusEvent` union in `src/types/events.ts`
- [x] 1.3 Add the telemetry projection of each member to `eventFields` in `src/lib/bus.ts`

## 2. The recorder mapping

- [x] 2.1 Branch the report family in `onEvent`, before `toKernelEvent`
- [x] 2.2 Mint the report QName cli-side, over `cliProvDigest` of the thread id
- [x] 2.3 Map the session creation: the report entity with the parent attribute, or the conversation action
- [x] 2.4 Map each act as one typed lifecycle action with the thread id and its data
- [x] 2.5 Map the version record: the version entity, attributed to the report entity
- [x] 2.6 Guard the mapping: a throw logs and returns, and the emitter never sees it
- [x] 2.7 Cover the mapping with targeted recorder tests, on the flushed document state

## 3. The two seam realizations

- [x] 3.1 Make `src/modules/harness/report_bridge.ts`: the seam events onto the bus members, with the system actor and the live session model
- [x] 3.2 Realize `readReportProvenance`: drain the flush, read the stored bytes, build the attestation
- [x] 3.3 Bind the two seams on the core bag in `src/modules/harness/runtime.ts`
- [x] 3.4 Pass the bound seam into `PrepareChatTurnDeps` at the chat-turn call site
- [x] 3.5 Cover both realizations with targeted tests, absence included

## 4. Verification

- [x] 4.1 Run `bun run typecheck`, and run the targeted test files of each changed area
- [x] 4.2 Run `bun run format:file` on each changed source file
