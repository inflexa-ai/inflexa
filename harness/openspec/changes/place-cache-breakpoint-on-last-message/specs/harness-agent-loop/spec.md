## MODIFIED Requirements

### Requirement: The loop caches its prompt prefix by default

`RunAgentOptions` MUST accept an optional `promptCache: PromptCachePolicy`. It
MUST default to `DEFAULT_PROMPT_CACHE` (`{ ttl: "5m" }`) when the caller supplies
none. A host whose endpoint ignores cache directives, or charges badly for them,
MUST be able to pass `"off"`.

The loop MUST resolve the policy ONCE per run. An identical policy across every
call is part of the cache contract, because the prefix must be byte-identical to
be read back.

The loop MUST place the breakpoint with `withPromptCacheBreakpoint` on each call,
and MUST NOT set `ChatRequest.providerOptions` for the cache. The breakpoint rides
the last message, and the transcript grows with each iteration. Thus the loop
re-derives the placement per call.

The placement MUST roll forward with the transcript. Each iteration appends the
reply of the model and the results of its tools. The next call then reads back
what the last call wrote. A breakpoint pinned before the tool messages makes each
iteration send the whole tool transcript uncached.

The forced wrap-up call MUST also carry a breakpoint. That call empties the tool
set, thus it reads nothing back and rewrites the prefix. The write is pure waste,
and the cache-write counter is what makes the waste visible.

#### Scenario: A run with no policy still caches

- **WHEN** `runAgent` is invoked with no `promptCache`
- **THEN** every LLM call it makes MUST carry the 5-minute cache directive on its last message

#### Scenario: No call carries a request-level directive

- **WHEN** `runAgent` makes any LLM call
- **THEN** `ChatRequest.providerOptions` MUST be unset, because a request-level directive is a breakpoint that an intermediary cannot count

#### Scenario: The breakpoint rolls forward across iterations

- **GIVEN** a run whose model calls a tool on each iteration
- **WHEN** the loop makes each call
- **THEN** the marked message index MUST grow from one call to the next

#### Scenario: The transcript the run returns is unmarked

- **WHEN** `runAgent` completes
- **THEN** no message of `AgentRunResult.messages` MUST carry a cache directive, because a host writes that array to a thread store

#### Scenario: A host opts out

- **WHEN** `runAgent` is invoked with `promptCache: "off"`
- **THEN** no LLM call it makes MUST carry a cache directive, on a message or on the request
