## ADDED Requirements

### Requirement: The tool emits the analogy report as a durable part

`generate_analogy_report` MUST emit one `data-analogy-report` part from the conversation agent after its child workflow returns. The part carries the id of the tool call and the full result of the tool: the report, or the `extraction-failed` envelope. The tool MUST give the same result to the model. The display storage keeps the part, and a reload gives the same part, field for field. A replay of the turn MUST NOT give a second part.

#### Scenario: A report arrives as a part and as the tool result

- **WHEN** `generate_analogy_report` returns a report
- **THEN** the turn emits one `data-analogy-report` part whose id is the id of the tool call and whose report equals the tool result
- **AND** the model gets the same report as the tool result

#### Scenario: An extraction failure arrives as a part

- **WHEN** `generate_analogy_report` returns the `extraction-failed` envelope
- **THEN** the turn emits one `data-analogy-report` part that carries that envelope

#### Scenario: A reload gives the stored part

- **GIVEN** a stored turn with a `data-analogy-report` part
- **WHEN** the transcript is reloaded
- **THEN** the read gives the same part, field for field

## MODIFIED Requirements

### Requirement: The agent gives the analogy report in its reply

The conversation prompt and the description of `generate_analogy_report` MUST tell the agent that the analogy block shows the report. Thus the reply MUST NOT copy the full report.

For a report, the reply names the analogies that matter by their `analogyTitle`. It says why they matter for the data of the analysis. It ends with one question about which analogy to pursue. For an `extraction-failed` envelope, the reply gives the message of the error and asks the user to narrow the problem.

#### Scenario: The prompt and the tool description send the report to the reply

- **WHEN** the conversation agent is built
- **THEN** its system prompt and the description of `generate_analogy_report` say that the analogy block shows the report
- **AND** they tell the agent to give a summary and one question in its reply, not the full report
