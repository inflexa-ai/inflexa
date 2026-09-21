# Proposal

## Why

The harness stores the author of a chat turn, but the cli stores none. `appendTurn`
accepts an optional `author` (`ConversationTurn`, `@inflexa-ai/harness`). The read path
carries the value back on the user message. The shared turn engine
(`src/modules/harness/turn.ts`) passes no author.

Thus each thread that the cli writes answers "who sent this message" with nothing. The cli
knows the person. It is the signed-in identity of the Auth0 session, the value that the
provenance recorder attributes an action to (`currentUserActor`,
`src/modules/prov/prov.ts`). The issue is inflexa-ai/inflexa#565, and the harness half is
archived already.

## What Changes

- The shared turn engine stamps the author on the append.
- The author is the email of the signed-in identity. A signed-out session records no
  author, thus an absent value never reads as a real one.
- The identity read moves into `currentUserEmail`, an exported function of the auth module.
  The provenance recorder calls it instead of its own copy.
- The engine resolves the author through its injectable edges (`ChatTurnSeams`). Thus the
  engine cases drive both branches with no auth file on disk.
- Both chat surfaces get the author from the engine. The TUI hook and the dev REPL pass no
  new argument.
- The run-outcome record (`src/tui/hooks/run_completion.ts`) does not change. That append
  opens on a synthetic row, and the harness spec covers it. `run-completion-notice` owns
  that record, thus this change states nothing about it.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `tui-harness-chat`: the shared turn engine stamps the author of the turn on the append,
  from the signed-in identity of the cli.

## Impact

Code:

- `src/modules/harness/turn.ts`: the `readAuthor` member of `ChatTurnSeams`, and the author
  on the `appendTurn` payload.
- `src/modules/auth/whoami.ts`: `currentUserEmail`, which gives the email of the signed-in
  identity, or `null`.
- `src/modules/prov/prov.ts`: `currentUserActor` calls `currentUserEmail`. The behavior does
  not change, and the edit prevents a second copy of one identity rule.
- `src/modules/harness/turn.test.ts`: the branches of the author at the append.
- `src/modules/auth/auth.test.ts`: the branches of the identity read.
- `src/tui/hooks/conversation.usage_recorder.test.ts`, `src/modules/harness/usage_ledger.test.ts`,
  and `src/modules/harness/agent_switch.test.ts`: each builds the edge bag literally, thus each
  gets the new member.

Contracts. The harness fields are optional, thus the change removes nothing and no
consumer breaks. The cli reads the transcript back through `storedMessagesToCortex`
(`src/tui/hooks/conversation.ts`), and it shows no author and no creation time today.

Out of scope:

- A display of the author or of the creation time in the TUI. The issue asks the contract
  to carry the two values, and inflexa-ai/lumen#169 shows them. The cli chat header shows a
  role label and a duration, thus a new readout there is a new design decision.
- The identity of the agent session (`buildChatSession`). It stays `local`, because the ask
  grants and the harness scope key on that value.
- An author on an assistant message. The role names the sender.
