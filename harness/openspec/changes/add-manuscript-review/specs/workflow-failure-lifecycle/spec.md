## ADDED Requirements

### Requirement: Manuscript review has one durable finalisation path

`executeManuscriptReview` SHALL own one replay-safe finalisation block that runs on success, partial phase failure, required parse/dossier failure, operator cancellation, and budget exhaustion. Phase bodies SHALL NOT write run-level terminal state. The finaliser SHALL settle every phase row, derive `completed` when all required phase outcomes complete, derive `partial` when a valid dossier contains useful results plus non-essential failed coverage, derive `failed` for parse or dossier-validation failure before a valid dossier, derive `canceled` for operator cancellation, and preserve the existing insufficient-funds status/authorization semantics for budget exhaustion. It SHALL register any valid dossier before terminal status, then write run status, close charge, revoke owned authorization, and emit exactly one matching terminal event through separately named durable steps that replay without duplicating side effects.

#### Scenario: All review phases complete

- **WHEN** all required manuscript-review phase outcomes complete and the dossier registers
- **THEN** the finaliser marks the run `completed`, revokes owned authorization, and emits one run-completed event

#### Scenario: Useful partial dossier survives a phase failure

- **WHEN** at least one substantive phase completed, a non-essential phase failed, and the dossier validates and registers
- **THEN** the finaliser marks the run `partial` and the completion event states that coverage is partial

#### Scenario: Required parse fails

- **WHEN** `review-parse` fails before a valid dossier exists
- **THEN** the finaliser marks the run `failed`, settles all unstarted phases as skipped, and emits one failure event without a review path

#### Scenario: Terminal side effect replays

- **WHEN** workflow recovery re-enters finalisation after dossier registration or authorization revoke already succeeded
- **THEN** named durable steps reuse recorded results and do not duplicate the artifact, revoke, or terminal event
