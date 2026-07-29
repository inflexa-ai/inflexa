## Why

Long-running analysis workflows outlive the chat turn that starts them, but the conversation agent receives no fresh run-state context on later turns. The only pull tool exposes a raw nested status and offers no bounded way to wait, which can lead the agent to repeatedly inspect a run that is still executing and to mistake capped history for a lost run.

## What Changes

- Inject a bounded, ephemeral Run Activity snapshot into every analysis-scoped conversation turn, listing running and suspended runs or explicitly stating that none exist.
- Keep the snapshot analysis-wide, fresh per turn, outside persisted thread history, and explicit when run state is temporarily unavailable.
- Make parameterless `inspect_run` order non-terminal runs before terminal history and disclose result truncation.
- Make targeted inspection return an unmistakable inspection state, with elapsed timing and no premature result paths while a run is still executing.
- Add a bounded `waitForTerminalSeconds` option for targeted inspection, with cutoff, cancellation, suspended-run, and self-run behavior defined.
- Return an explicit in-progress state from `execute_analysis` and teach the conversation agent to perform at most one bounded wait per turn rather than polling.
- Preserve the pull-only completion model: workflow completion updates the ledger and stream but does not automatically invoke the conversation agent.

## Capabilities

### New Capabilities

- `conversation-run-awareness`: Fresh, bounded run activity in the conversation tail and the conversation agent's rules for asynchronous run continuity.
- `run-inspection`: Active-first run listing, explicit targeted inspection states, and bounded waiting for terminal run state.

### Modified Capabilities

None.

## Impact

- Affects harness chat-turn preparation and message assembly, conversation-agent prompt content, run-state queries, `inspect_run`, and `execute_analysis`.
- Adds fields and optional inputs to model-facing tool results without changing the embedder-facing run ledger or workflow protocol.
- Requires focused unit tests for tail assembly, ordering and pagination metadata, inspection states, waiting/cancellation, and prompt/tool contracts.
- Adds no dependency and does not require CLI-specific behavior, a new persistence table, or an automatic completion consumer.
