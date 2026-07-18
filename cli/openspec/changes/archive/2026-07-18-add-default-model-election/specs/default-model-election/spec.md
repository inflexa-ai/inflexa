# default-model-election Specification (delta)

## ADDED Requirements

### Requirement: Model candidates rank deterministically by family preference, then recency

The default-model rank over a model list SHALL be a total order: candidates matching the
preferred family (the existing `MODEL_PREFERENCE` order: claude > gpt > gemini > qwen,
case-insensitive substring) rank first, ordered within the family by the listing's `created`
timestamp descending, with a missing `created` sorting as oldest and ties broken by id
ascending. When no family matches, the same recency order SHALL apply to the whole list. The
rank SHALL NOT depend on the serving order of the model list, and SHALL NOT use lexicographic
id order as the primary sort (ascending byte order ranks dated legacy ids first). The `/models`
response parsing SHALL carry `created` through as an optional field; a listing without it
degrades to the id-ascending tiebreak, still deterministic.

#### Scenario: Same list, same rank, any serving order

- **WHEN** the proxy serves the same model set in two different orders across two calls
- **THEN** both calls produce the identical ranked candidate sequence

#### Scenario: Recency outranks serving position

- **WHEN** the list serves an older claude id first and a newer claude id (greater `created`) later
- **THEN** the newer id ranks first

### Requirement: Election walks the rank and only a definite not-found advances it

Electing a default model SHALL walk the ranked candidates, validating each via the unbilled
`count_tokens` request when the candidate is claude-family on an anthropic-protocol connection,
with every round-trip bounded by the caller's timeout discipline. The validation verdict is
three-valued: a 200 elects the candidate; a definite `not_found_error` 404 advances to the next
candidate; any other outcome (timeout, non-404 status, network failure) is inconclusive and
SHALL elect the candidate anyway — a flaky network must not walk past the best candidate.
Non-claude-family candidates SHALL be elected by rank alone (no validation request exists for
them). If every candidate 404s, the election SHALL yield the top-ranked candidate unvalidated so
the existing probe failure reporting surfaces the state; the election itself SHALL never fail a
launch.

#### Scenario: Inaccessible top candidate is walked past

- **WHEN** the top-ranked claude id answers `count_tokens` with a `not_found_error` and the next answers 200
- **THEN** the next candidate is elected and no warning is emitted for the walk itself

#### Scenario: A transient validation failure does not distort the election

- **WHEN** the top-ranked candidate's `count_tokens` times out or answers a 5xx
- **THEN** that candidate is elected (inconclusive-accept), not walked past

#### Scenario: An all-404 list elects the top candidate for downstream reporting

- **WHEN** every ranked candidate answers `not_found_error`
- **THEN** the top-ranked candidate is returned and the launch probe's existing warn-and-proceed
  path reports the failure; launch is not blocked by the election

### Requirement: The elected winner is the process-cached auto default

`resolveModelId` SHALL perform the election (rank, then validation walk) and cache the elected
winner per process, so every consumer of the auto default in the same process — the launch
probe, harness boot's per-agent fallback — observes the same elected id without re-walking. The
cache SHALL retain its existing lifecycle (never invalidated at runtime; reset only by the
test hook).

#### Scenario: Probe and chat share one election

- **WHEN** the launch probe resolves the default and harness boot later resolves the per-agent
  fallback in the same process
- **THEN** boot receives the probe's elected id from the cache with no additional `/models` or
  validation requests
