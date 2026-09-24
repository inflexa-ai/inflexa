## ADDED Requirements

### Requirement: The analogical reasoner submits its report through terminal tools

The `analogical-reasoner` sub-agent of `generate_analogy_report` MUST declare two terminal tools from its first request, the same pattern as the planner with `submit_plan` and `report_blocker`. Each tool MUST take a top-level object:

- `submit_analogy_report` takes the report, validated by `AnalogyReportSchema`.
- `report_blocker` takes the reason of an extraction failure. It comes from `createReportBlockerToolFor`, as the planner and the synthesizer use it.

Each tool MUST record its outcome in the outcome cell of the call. When one round records a report and a blocker, the report MUST win. The wrapper MUST return the recorded report. For a recorded blocker, the wrapper MUST return the `extraction-failed` envelope with the reason as its message.

The wrapper MUST NOT parse the final text of the reasoner. It MUST NOT make a second model call that converts text into an envelope. The prompt of the reasoner MUST tell it to call a terminal tool one time, in place of a JSON reply.

#### Scenario: A submitted report is the result

- **GIVEN** a reasoner that calls `submit_analogy_report` with a valid report
- **WHEN** `generate_analogy_report` returns
- **THEN** the result is that report, and the provider got no conversion call

#### Scenario: A blocker gives the extraction-failed envelope

- **GIVEN** a reasoner that cannot extract the problem and calls `report_blocker` with a reason
- **WHEN** `generate_analogy_report` returns
- **THEN** the result is the `extraction-failed` envelope, and its message is that reason

#### Scenario: An invalid report gets feedback

- **GIVEN** a reasoner that submits a report that fails the schema
- **WHEN** the loop dispatches the call
- **THEN** the call gets an input validation error, the cell records no report, and the reasoner can submit again

### Requirement: A reasoner run without an outcome gets one salvage continuation

`generate_analogy_report` MUST drive the reasoner through `runToTerminal`, with the outcome cell as the terminal outcome (refer to the harness-agent-loop capability). When the run ends without an outcome, and it was not aborted, the salvage continuation MUST keep the declared tools of the reasoner. Its mask MUST let only `submit_analogy_report` and `report_blocker` run.

When the salvage also ends without an outcome, the wrapper MUST return the `extraction-failed` envelope. When the loop throws, the wrapper MUST return an `extraction-failed` envelope with the message of the error.

#### Scenario: A run that ends on prose is salvaged

- **GIVEN** a reasoner that ends on a text reply with no call of a terminal tool
- **WHEN** `generate_analogy_report` runs it
- **THEN** one salvage continuation runs, and its mask lets only `submit_analogy_report` and `report_blocker` run
- **AND** the report that the salvage records is the result

#### Scenario: No outcome after the salvage

- **GIVEN** a reasoner that records no outcome in the run or in the salvage
- **WHEN** `generate_analogy_report` returns
- **THEN** the result is the `extraction-failed` envelope, and no conversion call runs
