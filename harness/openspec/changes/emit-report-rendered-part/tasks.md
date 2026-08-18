# Tasks

## 1. The part vocabulary

- [x] 1.1 Add `ReportRenderedPart` to `src/contracts/chat-parts.ts` and to the `CortexChatPart` union, with the authority rule in its doc comment.
- [x] 1.2 Add `ReportRenderedPartSchema` to `src/contracts/schemas/chat-parts.ts` and to `CortexChatPartSchema`.
- [x] 1.3 Add the `data-report-rendered` entry to `PART_REGISTRY`: `conversation` / `conversation` / not transient / not reconciling.
- [x] 1.4 Export the type from `src/contracts/index.ts`.

## 2. The durable display projection

- [x] 2.1 Add the `report-rendered` key to `ConversationUIData` and to the stored-envelope `dataSchemas` in `src/memory/conversation-display-storage.ts`.
- [x] 2.2 Test that the recorder keeps the part in the position of its emission.

## 3. The emission

- [x] 3.1 Emit the part in `src/tools/report-session/preview-report.ts` on the rendered arm, with a per-emission `id`, `renderedAt`, and the document `title`.
- [x] 3.2 Test the arms: the rendered arm emits one well-formed part, and a degraded arm emits nothing.
