# Give neutral names to the chat contract types

## Why

The chat contract types of the harness carry Cortex names. But Cortex, Lumen, the terminal user interface (TUI) in `cli/`, and a web graphical user interface (GUI) that comes later all use these types. On 2026-09-28, the user decided that all consumers use one set of harness types with neutral names. The AI SDK `UIMessage` stays only inside the harness storage.

This change is part 1 of 3, and it changes the names only. Part 2 changes the TUI to use these types, and it moves the translators into the harness. Part 3 changes Cortex and Lumen to use the new names. Parts 2 and 3 are not in this change.

## What Changes

The harness renames seven contract types:

| Old name | New name | Module |
|-|-|-|
| `CortexChatEvent` | `ChatEvent` | `src/contracts/chat-events.ts` |
| `CortexChatPart` | `ChatPart` | `src/contracts/chat-parts.ts` |
| `CortexChatPartType` | `ChatPartType` | `src/contracts/part-registry.ts` |
| `CortexPart` | `MessagePart` | `src/contracts/message.ts` |
| `CortexMessage` | `ChatMessage` | `src/contracts/message.ts` |
| `CortexChatEventSchema` | `ChatEventSchema` | `src/contracts/schemas/chat-events.ts` |
| `CortexChatPartSchema` | `ChatPartSchema` | `src/contracts/schemas/chat-parts.ts` |

- `ChatFrame` is a new type, `ChatFrame = ChatEvent | ChatPart`. It is one event or one part on a chat stream or a run stream. Each barrel that exports `ChatEvent` also exports `ChatFrame`. Lumen declares the same union today, and it imports the harness type at a later harness bump.
- Each old name stays in its module as a deprecated alias of its new name, with the comment `/** @deprecated Use <new name>. */`. A type alias names the new type, for example `export type CortexMessage = ChatMessage;`. A schema alias is the same object as its new schema, for example `export const CortexChatEventSchema = ChatEventSchema;`.
- Each barrel that exports an old name today exports the new name in its place, and the alias beside it. These barrels are `src/contracts/index.ts`, `src/contracts/schemas/index.ts`, and `src/index.ts`.
- In `src/`, each use of an old name changes to the new name. The alias lines and their barrel exports are the only places that keep an old name.
- A code comment changes only where it names an old type, or where it calls these types Cortex-native or Cortex-owned.
- `harness/CLAUDE.md` names the new types.
- `harness/CONTEXT.md` does not call these types "Cortex-native".
- The requirement "The transcript read carries the author and the creation time" of the `harness-thread-history` spec names `ChatMessage` in the place of `CortexMessage`. The Impact section gives three places that keep `CortexMessage`.

## What Does Not Change

- `CortexRunRow`, `CortexPlanRow`, `CortexRunRowSchema`, and `CortexPlanRowSchema`. These types are the ledger rows of the `cortex_*` tables.
- The names of the functions `storedMessagesToCortex` and `conversationUIToCortexMessages`. The user decides these names later.
- The table names, the `cortex_*` identifiers, and the `CORTEX_*` environment variables.
- Each file outside `harness/`.
- The harness version, a changelog, and a lockfile.
- The behavior, and each runtime value.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `harness-thread-history`: The text of the requirement "The transcript read carries the author and the creation time" names `ChatMessage` in the place of `CortexMessage`. The behavior does not change.

## Impact

- Harness source: the seven declarations, the three barrels, each use of an old name in `src/`, and the comments. The uses are in the code and in the tests.
- Documents: `harness/CLAUDE.md` and `harness/CONTEXT.md`.
- Behavior: no change. A type alias has no runtime value. Each schema alias is the same object as its new schema.
- Consumers: Cortex pins harness 0.38.0, and Lumen pins harness 0.40.0. Both use the old names. After a bump to a harness release with this change, the code of each one compiles through the aliases. A deep import of an old name, for example from `@inflexa-ai/harness/contracts/message.js`, also resolves, because each alias stays in the module of its new name. Cortex and Lumen change to the new names at their next harness bump.
- The aliases are temporary. They let Cortex and Lumen compile on the old names until each one uses the new names.
- `cli/` uses no old name, and it compiles with no change.
- The spec: three places in `harness-thread-history` keep `CortexMessage` after this change:
  - The Purpose line. A delta cannot change the Purpose of a spec. When you archive this change, change `CortexMessage` to `ChatMessage` in that line directly.
  - The requirement "Stored AI SDK messages convert to CortexMessage". The open change `persist-versioned-conversation-display` removes this requirement. A rename in this change would make the result of the two archives depend on their order.
  - The requirement "Stored display projections convert to CortexMessage", which `persist-versioned-conversation-display` adds. When you archive that change, change `CortexMessage` to `ChatMessage` in that requirement.
- Release: the change does not bump the version in `package.json`. The user starts the harness release.
