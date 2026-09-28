## MODIFIED Requirements

### Requirement: The finish operation
The finish operation MUST validate the whole draft against the full document schema, the id rule, and the structural tier. It MUST report each gap as data. When the draft passes, it MUST give the valid `ReportDocument` value to its caller in the harness. The preview and the record read that value. The finish MUST NOT open a file, and it MUST NOT change the draft. The finish runs the structural tier only, and the value-tier gate of the report pipeline is a different capability.

The `finish_draft` tool MUST give the outcome of the finish without the document. A pass gives `valid: true` and the warnings. A failed finish gives the gaps and the warnings. The document grows with the report, and the preview and the record read it themselves.

The finish MUST also carry each advisory warning, in both outcomes. A free numeral in prose is such a warning: it needs no file, thus the finish scans for it. A prose numeral in an exponent form that the number helper would never print MUST warn too. Thus the prose notation and the page notation cannot drift silently. A warning MUST NOT decide the outcome.

The preview tool and the record tool run the same finish. Each MUST give the warnings of the finish on its `gaps` outcome, and on its `rendered` or `recorded` outcome. Thus the agent reads the warnings with no separate finish.

The finish MUST list each unused derivation as an advisory warning: a derivation record whose output path no binding of the document names. The warning names the output path, and it decides no outcome, exactly as a free-numeral warning does.

#### Scenario: An empty section is a gap at the finish
- **WHEN** the agent finishes a draft that holds one empty section
- **THEN** the finish reports the empty section as a gap, and it gives no document

#### Scenario: A complete draft finishes
- **WHEN** the preview finishes a draft that passes every rule
- **THEN** the finish gives the document value, and the draft stays as it is

#### Scenario: The tool gives a pass with no document
- **WHEN** the agent calls `finish_draft` on a draft that passes every rule
- **THEN** the result carries `valid: true` and the warnings, and no document

#### Scenario: An untitled draft is a gap at the finish
- **WHEN** the agent finishes a draft that carries no title
- **THEN** the finish reports the title as a gap, and it gives no document

#### Scenario: A free numeral warns
- **WHEN** the agent finishes a draft whose prose carries a figure with no metric block behind it
- **THEN** the finish carries a warning for that block, and the warning does not change the outcome

#### Scenario: A drifted exponent form warns
- **WHEN** a prose sentence writes `4.3e-05` where the helper prints `4.3e-5`
- **THEN** the finish carries a warning that names the block, and the outcome stays as the gaps decide

#### Scenario: The preview carries the warnings
- **WHEN** the preview renders a draft whose prose carries a free numeral
- **THEN** the `rendered` outcome carries the warning for that block

#### Scenario: The record carries the warnings beside the gaps
- **WHEN** the record runs on a draft with an empty section and a free numeral
- **THEN** the `gaps` outcome carries the gap and the warning

#### Scenario: An unused derivation warns
- **WHEN** the finish runs over a document that ignores one derivation record
- **THEN** the finish carries a warning that names the unused output, and the outcome stays as the gaps decide

#### Scenario: A used derivation warns nothing
- **WHEN** a binding names each derivation output
- **THEN** the finish carries no derivation warning
