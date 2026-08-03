## ADDED Requirements

### Requirement: Manuscript-review completion remains pull-only

Conversation guidance SHALL treat `review_manuscript` as an asynchronous launch that returns a run id and fixed-phase card, SHALL forbid polling loops, and SHALL direct a later turn to use one bounded `inspect_run` call when the user asks for status or results. A completion event SHALL NOT inject the review dossier into a new conversation turn. After terminal inspection advertises `reviewPath`, guidance SHALL direct the agent to read that registered dossier, present stored finding ids and commentability, and call `emit_review_docx` only after the user selects findings.

#### Scenario: Launch turn does not wait for review

- **WHEN** `review_manuscript` launches successfully
- **THEN** the conversation returns the run id/card without waiting for terminal state or repeatedly inspecting it

#### Scenario: Later result turn pulls the dossier

- **WHEN** the user asks for results after the run is terminal
- **THEN** the agent performs bounded inspection and reads only the advertised review artifact
