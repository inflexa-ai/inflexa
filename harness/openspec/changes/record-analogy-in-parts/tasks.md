# Tasks

- [x] 1.1 Split `AnalogyReportSchema` into the problem part and the analogy part, with no change of the report shape.
- [x] 1.2 Replace `submit_analogy_report` with `record_problem` and `record_analogy`, assemble the report, and end the run when each planned analogy has a record.
- [x] 1.3 Name the content filter in the message of a run that it stopped with no report.
- [x] 1.4 Update the tests and the analogy eval cases.
- [x] 1.5 Run `openspec validate record-analogy-in-parts --strict` in `harness`, and make sure that it passes.
