## MODIFIED Requirements

### Requirement: The host writes the methods and sources of a step

The parent MUST give each child the grounding of its plan step. The parent MUST also give the claim views that match the claims and the snapshot digest of that grounding. After the summarizer, inside the checkpointed step of the summary, the host MUST read the host copies of the decision records of the step. The host copies are under `.sandbox/decision-records/`, in the mirror of `output/` of the step.

The host MUST NOT read a record that only the step holds. The read MUST refuse a file that resolves out of the record directory of the step. It MUST also refuse a file past the size bound, and a file that does not parse. The host MUST then build the methods of the step:

- the grounding status and the snapshot digest
- one template entry for each record, with the method, the environment match, and the script path
- the claims of the grounding, then the claims of the records, with the title and the strength of the view when the plan kept one
- one source for each DOI, PubMed id, or URL of the record citations and of the view evidence
- the license of the rule text.

The claim list and the source list MUST be bounded, and each MUST count its tail. When a step has no grounding, no claim, and no record, the step MUST have no methods. The host MUST append the methods block to the summary markdown after a horizontal rule. The step MUST emit one `data-step-methods` part with the methods, beside the `data-step-summary` part. The part MUST be persistent and not reconciling.

#### Scenario: A grounded step with a decision record

- **GIVEN** a step whose grounding cites `R-0028@d560` with a view, and whose record names `tpl-edger-ql@1.8.0` and one DOI
- **WHEN** the summary step runs
- **THEN** `summary.md` ends with the methods block, which names the template, the method, the rule title, and the DOI
- **AND** the step emits one `data-step-methods` part with the same methods

#### Scenario: The agent deleted the copy of its decision record

- **GIVEN** a grounded step whose agent removed `output/decision_record_x.json`
- **WHEN** the summary step runs
- **THEN** the methods carry the template entry and the sources of the host copy

#### Scenario: A step with no host record

- **GIVEN** a grounded step with no host copy of a decision record
- **WHEN** the summary step runs
- **THEN** the methods carry the claims of the grounding and the sources of their views, and no template entry

#### Scenario: A record is a symlink out of the record directory

- **GIVEN** a record file in the record directory of the step that is a symlink to a file outside the directory
- **WHEN** the host reads the records
- **THEN** the host leaves the file out and reads nothing through it
