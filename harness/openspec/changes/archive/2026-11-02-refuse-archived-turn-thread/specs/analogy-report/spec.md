## ADDED Requirements

### Requirement: The agent gives the analogy report in its reply

The conversation prompt and the description of `generate_analogy_report` MUST tell the agent to give the report in its reply. No surface renders the result of the tool, thus the reply is the only place where the user sees the report. The prompt and the description MUST NOT promise a card or a different view of the report.

For a report, the reply gives each analogy that matters by its `analogyTitle`, with its solutions and their sources. It says why the analogy matters for the data of the analysis. It ends with one question about which analogy to pursue. For an `extraction-failed` envelope, the reply gives the message of the error and asks the user to narrow the problem.

#### Scenario: The prompt and the tool description send the report to the reply

- **WHEN** the conversation agent is built
- **THEN** its system prompt and the description of `generate_analogy_report` tell the agent to give the report in its reply
- **AND** neither of them says that a card or a different surface shows the report
