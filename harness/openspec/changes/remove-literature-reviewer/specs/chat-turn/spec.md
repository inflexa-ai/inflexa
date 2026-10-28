# Spec Delta

## MODIFIED Requirements

### Requirement: The root loop of a chat turn caches its prefix for 1 hour

The chat turn MUST run the root conversation loop with the cache policy `{ ttl: "1h" }`, through `RunAgentOptions.promptCache`. A host MUST be able to pass a different policy with the optional parameter `promptCache`, for example `{ ttl: "5m" }` or `"off"`.

A person can reply 5 to 60 minutes after the last reply. A 1-hour entry stays in the cache for that gap, and a 5-minute entry does not. A 1-hour write costs 2 times the base input price, and a 5-minute write costs 1.25 times.

The policy rides on the run, not on the provider configuration. Thus it reaches only the root loop, and each loop takes its policy from its own run options. Each other loop MUST keep `DEFAULT_PROMPT_CACHE`, which is 5 minutes:

- the planner
- the analogy report
- each workflow loop

The requests of such a loop start less than 5 minutes apart, thus a 1-hour write would cost more than it saves.

#### Scenario: The root loop writes 1-hour entries

- **GIVEN** a turn whose host passes no cache policy
- **WHEN** the root loop sends a request
- **THEN** the system prompt and the last message of the request carry the 1-hour cache directive

#### Scenario: A host policy wins

- **GIVEN** a host that passes `promptCache: { ttl: "5m" }` to the turn
- **WHEN** the root loop sends a request
- **THEN** the request carries the 5-minute cache directive

#### Scenario: A sub-agent loop keeps 5 minutes

- **GIVEN** a turn whose tool runs the planner
- **WHEN** the planner loop sends a request
- **THEN** the request carries the 5-minute cache directive
