# Proposal

## Why

`prepareChatTurn` gives `ok` for an archived thread, and the in-process turn then writes into hidden state. When a different analysis owns that thread, the model reads the transcript of that analysis with the context of the current analysis. The workflow open refuses the same thread only because its claim of the thread filters the tombstone. Thus the two paths agree by accident, and the preparation itself has no rule.

Also, the conversation prompt and the description of `generate_analogy_report` promise a card that no client renders. Thus the agent sends the user to a card that does not exist.

## What Changes

- The preparation of a chat turn gives `not_found` for a thread that a different analysis owns, also when that thread is archived.
- The preparation gives `not_found` for an archived thread of the same analysis. The turn does not restore the thread, and it writes no row into it.
- A failed make of the thread fails the preparation, because the preparation then has no row to examine.
- The `chat-turn` spec states that the open makes an absent thread, and that the in-process turn obeys the same thread rules.
- The conversation prompt and the description of `generate_analogy_report` tell the agent to give the report in its reply. They do not promise a card.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `chat-turn`: the open and the in-process turn make an absent thread, and they refuse an archived thread and a thread of a different analysis.
- `analogy-report`: the agent gives the report in its reply, because no surface renders the result of the tool.

## Impact

- `src/app/chat-turn.ts` (`openThread`) and `src/app/test/chat-turn.test.ts`.
- `src/prompts/conversation.ts`, `src/tools/research/generate-analogy-report.ts`, and `src/agents/test/conversation-agent.test.ts`.
- An embedder that calls `prepareChatTurn` or the in-process turn on an archived thread gets `not_found`. The workflow open gives `not_found` already. The cli change `state-chat-thread-creation` states the 404 of the cli route in the cli `local-server` spec.
- A failed make of the thread gives `prepare_failed`, and not a turn with no thread row.
