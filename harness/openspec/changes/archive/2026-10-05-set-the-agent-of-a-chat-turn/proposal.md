## Why

`runChatTurn` resolves the agent of a turn from the thread type. But the host gives the session, and thus its provenance, before the call. The loop reads the agent id from `session.provenance.agentId`. That id goes to the billing headers, to the usage records, and to the provenance of each file write.

A host with more than one agent cannot know the agent before the call. Thus a host must read the thread row a second time, or it records the report agent under the id of the conversation agent. A host that frames each event for its agent has the same problem: the first text delta carries no source.

A host also gets a refusal of the turn (`not_found`, `agent_unresolved`, `prepare_failed`) only from the same call that streams the turn. Thus an HTTP host must wait on its stream to know if it can answer with an error status.

The display of the user message has a second fault. The recorder gets the raw `userInput`, but the model gets the sanitized text. Thus a secret that the user pastes stays in the stored display, and each reload shows it.

## What Changes

- Add `openChatTurn(deps, { analysisId, threadId, userInput })`. It prepares the turn and resolves the agent. It gives a refusal, or an open turn with the `agent` and a `run` function.
- `runChatTurn` becomes `openChatTurn` and then `run`. Its result does not change.
- **BREAKING** The session of a turn becomes `ChatTurnSession`, a `RequestSession` with no provenance. The harness sets the provenance from the resolved agent: `{ agentId: agent.id, callPath: [agent.id] }`.
- The display of the user message comes from the sanitized user message of the preparation.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `chat-turn`: a turn opens before it runs, the harness sets the provenance of the root agent, and the display of the user message holds the sanitized text.

## Impact

- `src/app/chat-turn.ts` and its tests.
- `src/index.ts` exports `openChatTurn` and its types.
- A host removes the provenance from the session that it gives to a turn. A host that must know the agent, or answer a refusal before it streams, calls `openChatTurn`.
