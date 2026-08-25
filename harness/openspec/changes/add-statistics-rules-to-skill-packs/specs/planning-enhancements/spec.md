# planning-enhancements Delta

## ADDED Requirements

### Requirement: The planner prompt states the cross-step feature-selection rule

The Translational Considerations of the planner prompt MUST state the
two-clause leakage rule beside the biomarker-evaluation guidance. Clause one:
a feature list from a supervised contrast on the same samples is already a
selection. Clause two: the modeling step MUST select again inside
cross-validation, from the full feature matrix. If it cannot, the plan MUST
demand that the step reports the estimate as optimistic.

#### Scenario: A biomarker plan does not chain a full-cohort contrast into a panel

- **WHEN** the planner writes a plan with a differential-expression step and a
  later biomarker-panel step over the same samples
- **THEN** the plan instructs the modeling step to select features again
  inside cross-validation, or to report the estimate as optimistic
