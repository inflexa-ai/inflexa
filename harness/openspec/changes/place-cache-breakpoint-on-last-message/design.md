## Context

The cache keys on an exact prefix. The render order is tools, then system, then
messages. Thus one breakpoint at the end of the messages caches the whole prefix.
The request-level directive and the message-level directive cache the same bytes.
Only the placement differs.

## Decision

### Place the breakpoint on the last message

A block marker is countable. Each hop between the harness and the endpoint can
read it, trim it, and reason about it. A top-level field is countable only by the
endpoint.

This makes the harness safe against the class of defect, not against one version
of one proxy. The proxy budget is now correct, because the proxy sees every
breakpoint that the request holds.

### Roll the breakpoint forward, and do not pin it

The loop appends the reply of the model and the results of its tools on each
iteration. A breakpoint on the last message advances with them, and iteration N+1
reads back what iteration N wrote.

A pinned breakpoint at the end of the stable prefix looks attractive, because the
tail of a turn changes on each turn. But a pinned breakpoint makes each iteration
send the whole tool transcript uncached. A long tool loop is the case that
caching exists for, thus the rolling placement wins.

### Return a copy of the transcript

The loop pushes each new message onto the array that the caller gave it, and the
host writes that array to the thread store. A directive written into the array
goes into the store, and it comes back on each later turn. The count then grows
by one per turn until the endpoint refuses the request.

### Remove a directive that a stored message carries

`memory/ai-sdk-message-storage.ts` reads `cache_control` off a stored block. Thus
a row that an older build wrote can arrive with a directive already on it. Such a
directive spends a breakpoint that the harness did not budget. The placement
function removes each one, thus the invariant holds against the store as well as
against the loop.

### Move back past a thinking block

The Anthropic provider resolves a message-level directive onto the last content
part of the message. A thinking block cannot carry `cache_control`. The provider
drops the directive there, and it reports no error. The result is a silent cache
miss on each call after it. The server-side placement moved back for us before,
thus the function moves back too.

## Risks / Trade-offs

- The placement is now the responsibility of the harness. A future provider that
  changes which block can carry a marker breaks it silently. The unit tests pin
  the two known cases: a thinking block, and an empty content array.
- `promptCacheProviderOptions` stays in the barrel. An embedder can still attach
  it to a request and keep the defect. The alternative removes a public export
  and breaks an embedder that uses it correctly. The doc comment carries the
  warning instead.

## Verification

A live rig proved both halves. It ran CLIProxyAPI v7.2.148 with cloaking forced
on, against a mock endpoint that counts breakpoints and enforces the limit of
four:

- The request placement fails on turn 2, turn 3, and turn 4 with the HTTP 400.
  Turn 1 passes. Each failing request carries 5 breakpoints.
- The message placement passes on each turn, with 3 or 4 breakpoints.

Real chats through the CLI proxy against Anthropic passed on each turn. They
reported cache reads of 2050 and 2059 tokens after the first turn.
