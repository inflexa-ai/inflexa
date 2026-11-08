## ADDED Requirements

### Requirement: The briefing gives the methods of each upstream step

At dispatch the parent MUST give the handoff of each completed dependency the methods of that dependency. The methods come from the grounding of its plan step, the claim views of the run input, and the decision records in its `output/` directory. The read of the records MUST be the confined and bounded read of the methods of a step. The handoff MUST render the grounding and the snapshot digest, each template with its method, and the rules and the sources of the dependency. The rules and the sources MUST each be bounded by `UPSTREAM_METHODS_MAX_ITEMS`, with a count of the tail. The handoff MUST also list the in-sandbox path of each decision record, bounded by `MAX_UPSTREAM_DECISION_RECORDS`. A dependency with no grounding and no record MUST render as before.

#### Scenario: A report step after a grounded step

- **GIVEN** a step `T1S1` with a grounding that cites `R-0001@e7d0`, and a decision record of `tpl-deseq2-two-group@1.0.0` with one DOI
- **WHEN** the parent composes the seed of a step that depends on `T1S1`
- **THEN** the handoff of `T1S1` renders the grounding, the template with its method, the title of `R-0001@e7d0`, and the DOI
- **AND** the handoff lists the path of the decision record

#### Scenario: A dependency with no methods

- **WHEN** the parent composes the seed of a step whose dependency has no grounding and no decision record
- **THEN** the handoff of the dependency has no grounding line and no decision record line
