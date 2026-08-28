# run-observation-seam — delta

## MODIFIED Requirements

### Requirement: The parent workflow accepts an optional host run-observation callback

`ExecuteAnalysisDeps` MUST carry an optional `observeRun` callback through
which the host observes the progress of a run. It MUST be independent of the
run emit of the provenance seam. Neither surface is implemented in terms of
the other, and the two do not share a payload type. Neither is necessary for
the other to function. An embedder that supplies neither, either, or both
MUST get identical run behavior in all four cases.

The callback MUST be synchronous by signature (it returns `void`, never a
promise). Thus a host that does I/O dispatches the work, and it never awaits
inside the critical path of the workflow.

#### Scenario: A run executes unchanged with no observer

- **WHEN** `executeAnalysis` runs with `observeRun` absent
- **THEN** the steps, the status transitions, the ledger writes, and the
  terminal outcome equal a run with the dep supplied, and no observation work
  runs

#### Scenario: The two observation seams are independent

- **WHEN** the run emit member is bound and `observeRun` is not (or the
  reverse)
- **THEN** the supplied surface receives its full sequence, and the absent
  one is never invoked
