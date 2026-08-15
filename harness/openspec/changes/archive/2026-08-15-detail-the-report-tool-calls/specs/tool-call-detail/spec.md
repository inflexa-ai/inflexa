# Delta: tool-call-detail

## ADDED Requirements

### Requirement: A tool describes its result through an optional hook
A tool definition MUST accept an optional `describeResult` hook beside `describeCall`. The hook takes the parsed input and the ok-channel result, and it gives a string. It MUST be synchronous and pure, and it MUST never fail a call: a hook that throws or gives an unusable value yields no result detail. The finished event carries the recomputed detail when the hook gives one, and the started detail otherwise. The hook runs only on an ok outcome. The emit site normalizes a result detail exactly as it normalizes a call detail: one line, redaction, and the length cap.

#### Scenario: The finished event carries the result detail
- **WHEN** a tool with a result hook resolves ok
- **THEN** the finished event carries the hook's normalized text, and the started event keeps its own detail

#### Scenario: An error keeps the started detail
- **WHEN** a tool with a result hook resolves with an error outcome
- **THEN** the finished event carries the started detail, and the hook does not run

#### Scenario: A throwing result hook costs nothing
- **WHEN** a result hook throws
- **THEN** the call outcome is unchanged, and the finished event carries the started detail

#### Scenario: A result detail is normalized
- **WHEN** a result hook gives a multi-line text over the cap
- **THEN** the finished event carries one capped line
