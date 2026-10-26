# Spec Delta

## Purpose

The `generate_analogy_report` tool finds structural analogies for an open scientific problem. Its `analogical-reasoner` sub-agent extracts the problem, finds cited solutions from other fields, and gives the report through a submit tool.

## ADDED Requirements

### Requirement: The reasoner gives its report through submit tools

The reasoner MUST declare `submit_analogy_report` and `report_blocker` from its first request. `submit_analogy_report` checks the report against `AnalogyReportSchema` and gives back the accepted report or the issues. `report_blocker` records the reason of an extraction failure. Neither tool ends the run. The wrapper MUST NOT parse the final text of the reasoner, and it MUST NOT make a conversion call.

#### Scenario: An invalid report gets its issues

- **WHEN** the reasoner submits a report that fails the schema
- **THEN** the call gives back the issues, and the reasoner can submit again

### Requirement: The last accepted report is the result

When the run ends, the wrapper MUST give the last accepted report. With no accepted report, it MUST give the `extraction-failed` envelope with the reason of the first blocker. A report wins over a blocker.

#### Scenario: A report after a blocker wins

- **GIVEN** a run that records a blocker and then an accepted report
- **WHEN** `generate_analogy_report` returns
- **THEN** the result is the report

#### Scenario: A blocker gives the extraction-failed envelope

- **GIVEN** a run that records only a blocker
- **WHEN** `generate_analogy_report` returns
- **THEN** the result is the `extraction-failed` envelope, and its message is the reason of the blocker

### Requirement: A reasoner run with no outcome gets one salvage request

When the run ends with no report and no blocker, and it was not aborted, the wrapper MUST send one salvage request. Only `submit_analogy_report` and `report_blocker` can run in it. When the salvage also gives no outcome, or the loop throws, the wrapper MUST give the `extraction-failed` envelope.

#### Scenario: No outcome after the salvage

- **GIVEN** a reasoner that records no outcome in the run or in the salvage
- **WHEN** `generate_analogy_report` returns
- **THEN** the result is the `extraction-failed` envelope, and no conversion call runs
