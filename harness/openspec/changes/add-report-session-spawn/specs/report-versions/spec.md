## ADDED Requirements

### Requirement: One report session records one version
A caller of the record operation MUST record at most one version for each report thread. The record lands one time, when the mechanical gate passes and the user accepts the report. Before the acceptance, the session iterates the draft, and no version row exists. A correction after the acceptance is a new report session, and its version names the earlier version through the parent link. Thus every version row holds the ordinal 1, and the per-thread ordinal generality of the store stays unused. The store does not enforce this rule, and the requirement binds the session loop and the gate.

#### Scenario: The accepted report records one time
- **WHEN** the report session records its accepted document
- **THEN** the thread holds one version, and the version holds the ordinal 1

#### Scenario: A correction starts a new session
- **WHEN** the user asks for a correction after the acceptance
- **THEN** a new report session records the new version, and that version names the earlier version as its parent
