## ADDED Requirements

### Requirement: The shared HTTP helper names the harness

`apiFetch` MUST send the User-Agent `inflexa-harness (+https://inflexa.ai)` on
each request. A User-Agent in the `headers` option of the caller MUST win, in
any letter case. A provider can refuse the default value of the runtime, for
example `node` or `Bun/<version>`.

#### Scenario: A request with no User-Agent from the caller names the harness

- **GIVEN** a bio-API tool that fetches through `apiFetch` with no User-Agent in `headers`
- **WHEN** the request goes out
- **THEN** it carries `User-Agent: inflexa-harness (+https://inflexa.ai)`, and each other header of the caller stays

#### Scenario: The User-Agent of the caller wins

- **GIVEN** a caller that sets `user-agent` in `headers`
- **WHEN** the request goes out
- **THEN** it carries that value only
