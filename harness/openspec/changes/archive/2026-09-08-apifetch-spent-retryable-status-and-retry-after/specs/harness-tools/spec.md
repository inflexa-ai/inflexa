## MODIFIED Requirements

### Requirement: Tools distinguish expected outcomes from unexpected failures

A tool's `execute` MUST return `Promise<Result<Output, ToolError>>`. Expected outcomes — including "not found", "empty", and "ambiguous" — MUST be `ok` data variants of `Output`, never an error. An unexpected failure (network, upstream 5xx, timeout, a retryable status that outlived the retries) MUST be an `err(ToolError)` or a throw. The loop maps both to one `tool_result { is_error: true }`. The `ok` `Output` MUST NOT carry a `success` boolean or an `error` field.

#### Scenario: A not-found result is returned as data

- **GIVEN** a gene-lookup tool queried for a non-existent symbol
- **WHEN** `execute` runs
- **THEN** it returns `ok` whose `notFound` list contains that symbol, and does not error

#### Scenario: An upstream failure surfaces as an error, not a success value

- **GIVEN** a tool whose external API returns 503
- **WHEN** `execute` runs
- **THEN** it throws or returns `err(ToolError)` rather than an `ok` carrying `{ success: false }`

#### Scenario: A response that violates the expected schema surfaces as an unexpected failure

- **GIVEN** a bio-API tool that fetches a JSON response through the schema-validating fetch helper (`apiFetchValidated`)
- **WHEN** the upstream returns a payload whose shape or field types do not match the declared Zod schema (a changed contract, or an error envelope where data was expected)
- **THEN** the fetch resolves to an unexpected `invalid_response` `ApiError` — which the tool surfaces as an error rather than mapping malformed data into an `ok` result. A partial-but-valid response (fields the schema marks optional are absent) still parses and is handled as data.

#### Scenario: A throttle that outlives the retries is not an absence

- **GIVEN** a bio-API tool that fetches through `apiFetch`, and an upstream that answers 429 on every attempt
- **WHEN** `execute` runs
- **THEN** the fetch resolves to the unexpected `exhausted` `ApiError`, and the tool surfaces it as an error rather than as a "not found" data variant
