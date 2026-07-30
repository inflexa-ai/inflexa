# harness-agent-loop Specification (delta)

## MODIFIED Requirements

### Requirement: Cache token usage is recorded per run

`runAgent` SHALL accumulate the `ChatUsage` a provider reports across every LLM call the run makes — the forced wrap-up included — and record it on completion, keyed by `agent_id`, as counters for input tokens, output tokens, cache-read tokens, and cache-write tokens (alongside the iteration histogram and the cap-hit counter). Only what a provider actually reports SHALL be recorded: a provider that reports no usage SHALL contribute nothing rather than zero.

Beyond the counters, the loop SHALL deliver each LLM call to the injected `UsageRecorder` as an attributed usage record at call completion, and SHALL surface its accumulated usage on its finish event — the root loop of a turn additionally surfacing the turn total, descendant loops included — all per the llm-usage-accounting capability. The counters, the records, and the finish rollups are three surfaces over the same per-call capture: none replaces another, and the absent-means-not-reported rule holds on all three.

These two cache counters are what make prompt caching observable at all. The hit rate for an agent type is `cache_read_tokens / input_tokens` (the harness's `inputTokens` being the total billed prefix, cache reads included), and a flat-zero read counter against a non-zero write counter is the runtime symptom of a defeated cache — either a shifting prefix or an endpoint that ignores cache directives outright.

#### Scenario: A cached run records reads and writes separately

- **GIVEN** a multi-iteration run whose provider reports cache creation on the first call and cache reads on the rest
- **WHEN** the run completes
- **THEN** both the cache-read and cache-write counters SHALL be recorded for that `agent_id`

#### Scenario: A provider reporting no usage records no tokens

- **GIVEN** a provider that reports no `usage`
- **WHEN** the run completes
- **THEN** no token counter SHALL be incremented for it — not even with zero

#### Scenario: Every call reaches the recorder

- **GIVEN** a run of several LLM calls ending in a forced wrap-up
- **WHEN** the run completes
- **THEN** the injected `UsageRecorder` SHALL have received one attributed record per call, the wrap-up call included
