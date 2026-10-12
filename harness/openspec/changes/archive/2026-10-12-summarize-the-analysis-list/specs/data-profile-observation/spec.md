# Spec Delta

## ADDED Requirements

### Requirement: The embedder hears each settle of a profile

The data-profile deps MUST accept an optional settle notice. The notice is a notice hook of the harness: it takes one settlement and gives `ResultAsync<void, NoticeFailure>`. The settlement MUST carry these fields:

- `analysisId`
- `status`: `completed` or `failed`
- `completedAt`: the completion time that the terminal write stamped on the ledger row, as an ISO 8601 string

The workflow body MUST call the notice after a terminal write of the profile row stamps that row. The terminal write admits one stamp for each `running` claim. Thus the notice MUST run one time for each settled claim, and a recovery replay that finds the row settled MUST NOT call it again. The body MUST NOT call the notice when the guard of the terminal write refuses the stamp.

The body MUST deliver the notice through the notice helper of the harness. A failed notice MUST go to the log, and the outcome of the profile MUST stay as the ledger recorded it. When the deps carry no notice, the body MUST call nothing and behave as before.

Only the workflow body sends the notice. A reset of a row outside the body sends none, for example the expiry of a stale profile or the reset of an orphaned profile.

#### Scenario: A completed profile notices its settle

- **GIVEN** data-profile deps with a settle notice
- **WHEN** a profile workflow completes and stamps its row `completed`
- **THEN** the notice gets one settlement with the analysis id, the status `completed`, and the stamped completion time

#### Scenario: A failed profile notices its settle

- **GIVEN** data-profile deps with a settle notice
- **WHEN** a profile workflow fails and stamps its row `failed`
- **THEN** the notice gets one settlement with the status `failed`

#### Scenario: A refused stamp sends no notice

- **GIVEN** a profile row that a different writer moved out of `running`
- **WHEN** the workflow body reaches its terminal write and the guard refuses it
- **THEN** the notice is not called

#### Scenario: A failed notice does not change the profile

- **WHEN** the settle notice gives an `err`
- **THEN** the harness logs the failure, and the ledger row keeps its settled status

#### Scenario: No notice is bound

- **WHEN** the data-profile deps carry no settle notice
- **THEN** the profile settles as before, and nothing is called
