## MODIFIED Requirements

### Requirement: Model candidates rank deterministically by family preference, then recency

The default-model rank over a model list MUST be a total order. The candidates of the preferred family rank first. The family order is the `MODEL_PREFERENCE` order: claude, then gpt, then gemini, then qwen. A candidate matches a family when its id contains the family name, with no case sensitivity.

In the family, the candidates come in the descending order of the `created` timestamp of the listing. A missing `created` sorts as the oldest, and the id in ascending order breaks a tie. When no family matches, the same recency order MUST apply to the whole list.

The rank MUST NOT depend on the serving order of the model list. It MUST NOT use the lexicographic id order as the primary sort, because the ascending byte order ranks the dated legacy ids first. The parse of the `/models` response MUST carry `created` through as an optional field. A listing with no `created` falls to the id tiebreak, which is still deterministic.

A source can give the release date as `created_at` (RFC 3339) in place of `created` (Unix seconds). The rank MUST read either field. An absent or invalid value, the epoch, or an earlier time MUST count as a missing date. The interactive direct setup MUST give the release date of each listed id to this rank. The dates come from the listing of the credential probe, or from the listing attempt of the setup. Thus the setup pre-fills the newest model of the preferred family.

#### Scenario: Same list, same rank, any serving order

- **WHEN** the proxy serves the same model set in two different orders across two calls
- **THEN** both calls produce the identical ranked candidate sequence

#### Scenario: Recency outranks serving position

- **WHEN** the list serves an older claude id first and a newer claude id (greater `created`) later
- **THEN** the newer id ranks first

#### Scenario: The direct setup pre-fills the newest listed model

- **WHEN** the direct endpoint lists `claude-3-haiku-20240307` with `created_at` `2024-03-07T00:00:00Z` and `claude-opus-5-5` with `created_at` `2026-09-21T00:00:00Z`
- **THEN** the model prompt of the setup pre-fills `claude-opus-5-5`
