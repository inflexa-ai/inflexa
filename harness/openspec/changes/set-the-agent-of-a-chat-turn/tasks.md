## 1. The chat turn

- [x] 1.1 Add `openChatTurn`, which prepares the turn, resolves the agent, and gives a refusal or an open turn with `agent` and `run`
- [x] 1.2 Make `runChatTurn` call `openChatTurn` and then `run`
- [x] 1.3 Change the session of a turn to `ChatTurnSession`, and set the provenance from the resolved agent
- [x] 1.4 Make the display of the user message from `prepared.userMessage`
- [x] 1.5 Export `openChatTurn` and its types from `src/index.ts`

## 2. Tests

- [x] 2.1 An open report thread gives the report agent, and its run carries the id of that agent on each usage record
- [x] 2.2 A thread of a different analysis is refused at the open, and no row of the turn exists
- [x] 2.3 The stored display of the user message holds the redacted text, and not the secret

## 3. Verify

- [x] 3.1 `tsc -p tsconfig.json` is clean
- [x] 3.2 `bun test` passes
