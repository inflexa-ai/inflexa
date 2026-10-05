# Tasks

## 1. The part vocabulary

- [x] 1.1 Add `ReportSessionStartedPart` to `src/contracts/chat-parts.ts` and to the `CortexChatPart` union, with the authority rule in its doc comment.
- [x] 1.2 Add `ReportSessionStartedPartSchema` to `src/contracts/schemas/chat-parts.ts` and to `CortexChatPartSchema`.
- [x] 1.3 Add the `data-report-session-started` entry to `PART_REGISTRY`: `conversation` / `conversation` / not transient / not reconciling.
- [x] 1.4 Export the type from `src/contracts/index.ts`.

## 2. The durable display projection

- [x] 2.1 Add the `report-session-started` key to `ConversationUIData` and to the stored-envelope `dataSchemas` in `src/memory/conversation-display-storage.ts`.
- [x] 2.2 Test that the recorder keeps the part in the position of its emission.

## 3. The emission

- [x] 3.1 Emit the part in `src/tools/start-report-session.ts` on the started arm, with `threadId` and `parentThreadId`.
- [x] 3.2 Test the three arms: started emits one part, existing-session emits nothing, and a refusal emits nothing.
