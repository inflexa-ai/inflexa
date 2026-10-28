# Record the analogy report in parts

## Why

The analogical reasoner sent the whole report in one call of `submit_analogy_report`. The safety filter of the provider can stop a reply in the middle of a call. Then the call is lost whole, the model reads only "JSON parsing failed", and it sends the whole report again. In the decision evals, a problem about bacteria that survive an antibiotic got cut in 9 of 10 trials, and the run often ended with no report. A smaller unit of record loses less on each cut.

## What Changes

- The reasoner records the problem and its planned analogies with `record_problem`, and each analogy with `record_analogy` when its search is done. `submit_analogy_report` goes.
- The wrapper assembles the report from the last accepted record of each part. A planned analogy with no record arrives as `not_loaded`.
- The run ends when each planned analogy has a record, thus no request is spent on prose that the wrapper does not read.
- A run that a content filter stopped with no report gives a message that names the filter.
- The contract of the report to the conversation agent and the frontend does not change.

## Impact

- `harness/src/tools/research/generate-analogy-report.ts`, `harness/src/contracts/analogy-report.ts`, `harness/src/prompts/analogical-reasoner.ts`, and their tests.
- `evals/cases/analogy.ts`: the grader reads the record calls.
