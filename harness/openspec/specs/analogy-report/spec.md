# analogy-report Specification

## Purpose
The `generate_analogy_report` tool finds structural analogies for an open scientific problem. Its `analogical-reasoner` sub-agent extracts the problem, finds cited solutions from other fields, and gives the report through a submit tool.

## Requirements

### Requirement: The reasoner records its report in parts

The reasoner MUST declare `record_problem`, `record_analogy`, and `report_blocker` from its first request. `record_problem` checks the extraction of the problem and the planned analogies. `record_analogy` checks one analogy against the analogy part of `AnalogyReportSchema`. A rejected call gives back the issues. `report_blocker` records the reason of an extraction failure. The wrapper MUST NOT parse the final text of the reasoner, and it MUST NOT make a conversion call. The run MUST end when the problem and each planned analogy have an accepted record.

#### Scenario: An invalid report gets its issues

- **WHEN** the reasoner records an analogy that fails the schema
- **THEN** the call gives back the issues, and the reasoner can record it again

#### Scenario: The last record of each part ends the run

- **GIVEN** a problem record that plans one analogy
- **WHEN** the reasoner records that analogy
- **THEN** the run ends, and no further request goes to the model

### Requirement: The last accepted report is the result

When the run ends, the wrapper MUST assemble the report from the last accepted problem record and the last accepted record of each analogy title. The analogies MUST keep the planned order. A planned analogy with no record MUST arrive with `coverage: "not_loaded"` and no solutions. With no accepted problem record, the wrapper MUST give the `extraction-failed` envelope with the reason of the first blocker. A report wins over a blocker. A run that a content filter stopped, with no report and no blocker, MUST give a message that names the filter.

#### Scenario: A report after a blocker wins

- **GIVEN** a run that records a blocker and then the problem and its analogies
- **WHEN** `generate_analogy_report` returns
- **THEN** the result is the report

#### Scenario: A blocker gives the extraction-failed envelope

- **GIVEN** a run that records only a blocker
- **WHEN** `generate_analogy_report` returns
- **THEN** the result is the `extraction-failed` envelope, and its message is the reason of the blocker

#### Scenario: A planned analogy with no record

- **GIVEN** a problem record that plans two analogies, and a record of the first one only
- **WHEN** `generate_analogy_report` returns
- **THEN** the report holds the first analogy, and the second one with `coverage: "not_loaded"` and no solutions

### Requirement: A reasoner run with no outcome gets one salvage request

When the run ends with no report and no blocker, and it was not aborted, the wrapper MUST send one salvage request. Only `record_problem`, `record_analogy`, and `report_blocker` can run in it. When the salvage also gives no outcome, or the loop throws, the wrapper MUST give the `extraction-failed` envelope.

#### Scenario: No outcome after the salvage

- **GIVEN** a reasoner that records no outcome in the run or in the salvage
- **WHEN** `generate_analogy_report` returns
- **THEN** the result is the `extraction-failed` envelope, and no conversion call runs
