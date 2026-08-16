# Delta: report-authoring

## MODIFIED Requirements

### Requirement: The finish carries the advisory warnings

The finish MUST list each unused derivation as an advisory warning: a derivation record whose output path no binding of the document names. The warning names the output path, and it decides no outcome, exactly as a free-numeral warning does.

#### Scenario: An unused derivation warns

- **WHEN** the finish runs over a document that ignores one derivation record
- **THEN** the finish carries a warning that names the unused output, and the outcome stays as the gaps decide

#### Scenario: A used derivation warns nothing

- **WHEN** every derivation output is named by a binding
- **THEN** the finish carries no derivation warning
