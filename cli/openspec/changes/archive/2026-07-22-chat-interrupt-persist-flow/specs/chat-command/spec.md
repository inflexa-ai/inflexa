## MODIFIED Requirements

### Requirement: Interrupt aborts the turn, not the process

During a streaming turn, an interrupt (Ctrl+C) SHALL abort the in-flight turn via its
abort signal and return to the prompt. The aborted run RESOLVES with its partial transcript under
the harness abort contract, and the engine SHALL persist `[userMessage, …partialLoopOutput]` — the
tokens already streamed to the terminal enter the thread, carrying the harness interruption marker
on the final assistant message; an abort before any output persists the user's message alone. At
the idle prompt, an interrupt (or EOF) SHALL exit the REPL cleanly: release held locks
and shut the runtime down through the existing graceful-shutdown path. A second interrupt
while an abort is already in flight MAY force-exit the process.

#### Scenario: Mid-turn interrupt returns to the prompt

- **WHEN** the user presses Ctrl+C while the agent is mid-turn
- **THEN** the turn's signal aborts, the user's message and the streamed partial are persisted to the thread, and the REPL shows the next prompt in the same process

#### Scenario: At-prompt interrupt exits cleanly

- **WHEN** the user presses Ctrl+C (or EOF) at the idle prompt
- **THEN** the REPL releases held locks and exits through the graceful-shutdown path
