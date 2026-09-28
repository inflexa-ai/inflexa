# Tasks

Run each command in `harness/`, unless the task names a different directory.

## 1. Rename the declarations

- [x] 1.1 In `src/contracts/chat-events.ts`, rename `CortexChatEvent` to `ChatEvent`. Below it, add `export type CortexChatEvent = ChatEvent;` with the comment `/** @deprecated Use ChatEvent. */`. Make sure that `bun run typecheck` passes.
- [x] 1.2 In `src/contracts/chat-parts.ts`, rename `CortexChatPart` to `ChatPart`. Below it, add `export type CortexChatPart = ChatPart;` with the comment `/** @deprecated Use ChatPart. */`. Make sure that `bun run typecheck` passes.
- [x] 1.3 In `src/contracts/part-registry.ts`, rename `CortexChatPartType` to `ChatPartType`. Below it, add `export type CortexChatPartType = ChatPartType;` with the comment `/** @deprecated Use ChatPartType. */`. Make sure that `bun run typecheck` passes.
- [x] 1.4 In `src/contracts/message.ts`, rename `CortexPart` to `MessagePart`. In the same module, rename `CortexMessage` to `ChatMessage`. Below each new name, add the alias of its old name with the comment `/** @deprecated Use <new name>. */`. Make sure that `bun run typecheck` passes.
- [x] 1.5 In `src/contracts/schemas/chat-events.ts`, rename `CortexChatEventSchema` to `ChatEventSchema`. Below it, add `export const CortexChatEventSchema = ChatEventSchema;` with the comment `/** @deprecated Use ChatEventSchema. */`. Do not make a second schema. Make sure that `bun run typecheck` passes.
- [x] 1.6 In `src/contracts/schemas/chat-parts.ts`, rename `CortexChatPartSchema` to `ChatPartSchema`. Below it, add `export const CortexChatPartSchema = ChatPartSchema;` with the comment `/** @deprecated Use ChatPartSchema. */`. Do not make a second schema. Make sure that `bun run typecheck` passes.

## 2. Add ChatFrame

- [x] 2.1 In `src/contracts/chat-events.ts`, add `export type ChatFrame = ChatEvent | ChatPart;` below `ChatEvent`. Import `ChatPart` from `./chat-parts.js` with `import type`. `chat-parts.ts` does not import `chat-events.ts`, thus the import makes no cycle. Describe a frame in the doc comment: one event or one part on a chat stream or a run stream. Make sure that `bun run typecheck` passes.

## 3. Export the new names

- [x] 3.1 In `src/contracts/index.ts`, export `ChatEvent`, `ChatPart`, `ChatPartType`, `MessagePart`, `ChatMessage`, and `ChatFrame`. Keep the export of each old name, because each old name is an alias now. Make sure that `bun run typecheck` passes.
- [x] 3.2 In `src/contracts/schemas/index.ts`, export `ChatEventSchema` and `ChatPartSchema`. Keep the exports of `CortexChatEventSchema` and `CortexChatPartSchema`. Make sure that `bun run typecheck` passes.
- [x] 3.3 In `src/index.ts`, export `ChatEvent`, `ChatPart`, `ChatPartType`, and `ChatFrame`. Keep the exports of `CortexChatEvent`, `CortexChatPart`, and `CortexChatPartType`. Do not add `ChatMessage`, `MessagePart`, `ChatEventSchema`, or `ChatPartSchema`, because this barrel does not export their old names today. Make sure that `bun run typecheck` passes.

## 4. Use the new names inside the harness

- [x] 4.1 Replace each use of an old name in `src/` with its new name, in the code and in the tests. Replace whole words only, thus `conversationUIToCortexMessages` keeps its name. Keep the alias lines and their barrel exports. Make sure that `bun run typecheck` passes. Make sure that this grep finds only the alias lines and their barrel exports:

  ```bash
  grep -rnwE 'CortexChatEvent|CortexChatPart|CortexChatPartType|CortexPart|CortexMessage|CortexChatEventSchema|CortexChatPartSchema' src
  ```

## 5. Change the comments and the documents

- [x] 5.1 Change each code comment that names an old type, or that calls these types Cortex-native or Cortex-owned. Write the current state, not the history, as "Code Comments" in `harness/CLAUDE.md` defines. Keep the comments in `src/contracts/usage.ts` and `src/contracts/data-profile.ts`, because they describe types that this change does not rename. Keep the Cortex-owned comments in `src/state/`, `src/tasks/`, and `src/workflows/`, because they are not about these types. Make sure that `grep -rniE 'cortex[- ](native|owned)' src` then finds only those comments. On the base commit, these are the comments to change:
  - `src/index.ts`: "the Cortex-native chat-stream vocabulary"
  - `src/contracts/chat-events.ts`: the module header, and the comment on `ChatEvent`
  - `src/contracts/chat-parts.ts`: "Cortex chat data parts"
  - `src/contracts/message.ts`: "Cortex-owned chat message types"
  - `src/contracts/schemas/chat-events.ts`: "Cortex-native chat-stream events"
  - `src/contracts/schemas/chat-parts.ts`: "Cortex chat data parts"
  - `src/memory/conversation-display-storage.ts`: each "Cortex part"
- [x] 5.2 In `harness/CLAUDE.md`, change the item "Shared contracts" to name `ChatEvent` and `ChatPart`. Remove the word "Cortex-native" from that item. Write the item in Simplified Technical English (STE), as the root `CLAUDE.md` defines. Make sure that `grep -nwE 'CortexChatEvent|CortexChatPart' CLAUDE.md` finds no line.
- [x] 5.3 In `harness/CONTEXT.md`, two lines call these types "Cortex-native". On the base commit, these are lines 355 and 544. Replace "Cortex-native" in these two lines with neutral words, in STE, as the root `CLAUDE.md` defines. Make sure that `grep -niE 'cortex[- ]native' CONTEXT.md` finds no line.

## 6. Checks

- [x] 6.1 Run `bun run format:file` with each changed file in `src/`. Make sure that the command exits with code 0.
- [x] 6.2 Run `bun run typecheck && bun run lint`. Make sure that the command passes.
- [x] 6.3 If a container runtime is available, run `bun run test:full`. Make sure that the command passes. If no container runtime is available, run `bun test` on each suite that does not use a database. Report each suite that did not run.
- [x] 6.4 In `cli/`, run `bun run harness:local && bun run typecheck`. Make sure that the command passes with no change in `cli/`.
- [x] 6.5 Run `openspec validate rename-chat-contract-types --strict`. Make sure that the command passes.
- [x] 6.6 Run the grep of task 4.1 again. Make sure that it finds only the alias lines and their barrel exports.
