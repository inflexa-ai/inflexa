## MODIFIED Requirements

### Requirement: Sidecar lifecycle is lazy, loopback-only, and reaped

The provider SHALL spawn `llama-server` lazily on first `embed()` (a process that never embeds never spawns it), bind it to `127.0.0.1` on an ephemerally allocated free port, and protect it with a per-spawn minted API key delivered through the child process's environment — never through argv, where it would be readable in the host's process listing. Readiness SHALL require two gates: the server's public health endpoint reporting the model loaded, then one authenticated request to a key-gated endpoint succeeding with the minted key — the health endpoint is unauthenticated upstream, so only the second gate proves the server on this port holds our key (and proves key delivery end-to-end at launch: an auth rejection of our own key fails the launch with an actionable error rather than surfacing at first embed). Every readiness request SHALL carry its own bounded timeout in addition to the shared deadline, so a half-open server that accepts connections but never answers cannot hold the launch past the advertised bound. Launch SHALL observe the child's exit: a child that exits before becoming healthy fails that launch attempt immediately (the health timeout is a bound, not a sentence), and a sidecar that exits after becoming ready SHALL invalidate the cached readiness so the next `embed()` spawns a fresh one — a mid-session crash costs one failed batch, never the rest of the process lifetime. The child's stderr SHALL be continuously drained into a bounded tail (an undrained pipe would eventually block the server); when a launch fails because the child exited, the drain's completion SHALL be awaited (the exit closes the pipe, so completion is prompt) before the tail is read, so the failure always includes the server's final diagnostics rather than racing them. Before any sidecar traffic flows, the proxy bypass SHALL compute the union of existing entries across both `NO_PROXY` spellings, add the loopback hosts, and write the same union to both spellings — a user's proxy-bypass entry present in only one spelling SHALL never be shadowed. Input-length guarding against the model's token ceiling is its own requirement (token-exact truncation) and runs against the ready sidecar.

#### Scenario: Lazy spawn and reuse

- **WHEN** `embed()` is called for the first time
- **THEN** the sidecar is spawned, health-checked, and used — and subsequent `embed()` calls in the same process reuse it without a new spawn

#### Scenario: No embed, no sidecar

- **WHEN** a CLI process never calls `embed()`
- **THEN** no sidecar process is ever spawned

#### Scenario: Key is not visible in the process listing

- **WHEN** the sidecar is running
- **THEN** the minted API key appears in the child's environment, not in its command line

#### Scenario: Readiness requires the key to be honored

- **WHEN** a server on the sidecar's port answers the public health probe but rejects the minted key on the authenticated gate
- **THEN** the launch fails with an error naming the authentication mismatch — it is never declared ready

#### Scenario: Half-open server cannot hang the launch

- **WHEN** a process on the sidecar's port accepts connections but never answers the readiness requests
- **THEN** each request times out individually and the launch fails at the shared deadline, not later

#### Scenario: Early exit fails fast with complete diagnostics

- **WHEN** the spawned server exits before answering the health probe (port already bound, unloadable model)
- **THEN** that launch attempt fails as soon as the exit is observed — not after the full readiness timeout — and the failure includes the server's complete final stderr tail, never a partially drained one

#### Scenario: Crash after readiness triggers respawn

- **WHEN** the sidecar exits after having served embeddings and `embed()` is called again
- **THEN** the cached readiness is invalidated and a fresh sidecar is spawned for the new request

#### Scenario: Single-spelling proxy bypass is preserved

- **WHEN** the user has proxy-bypass entries in only one of `NO_PROXY`/`no_proxy` and the sidecar launches
- **THEN** both spellings end up carrying the union of the user's entries plus loopback, and no previously honored entry is dropped from either

## ADDED Requirements

### Requirement: Input truncation is token-exact and guaranteed under the model's ceiling

The provider SHALL bound every input under the model's 512-token per-input ceiling before it reaches the embeddings endpoint, budgeting 510 content tokens — the tokenizer wraps content in a `[CLS]`/`[SEP]` pair that consumes the remaining two positions. The bound SHALL be exact, not probabilistic: an input the guard passes SHALL never be rejected by the server as over-length. Token counts SHALL be measured with the ready sidecar's own `/tokenize` endpoint — the same process and tokenizer that serves the embed — at the server root (not under `/v1`), sending the minted API key, with a bounded per-request timeout, counting content tokens only (no special tokens; the budget already reserves the pair).

An input of at most 510 UTF-16 code units SHALL pass unchanged with no measurement round-trip — a WordPiece token consumes at least one code unit, so its token count cannot exceed its length. A longer input SHALL first be measured whole and pass unchanged when it fits the budget. An input measuring over budget SHALL be truncated keeping the head, cut proportionally to its measured chars-per-token density with the cut backed off to a word boundary when one sits near it, and every candidate SHALL be re-measured before use, within a bounded number of measurement rounds. When the rounds are exhausted, or when any `/tokenize` interaction fails (error, timeout, malformed body), the provider SHALL fall back to a hard cut at 510 code units — which provably fits without a tokenizer — so measurement can never fail an embed. Tokenize interaction SHALL flow as `Result` values per the CLI's error discipline; a measurement failure selects the fallback rather than propagating into the embed's error channel.

#### Scenario: Short input skips measurement

- **WHEN** an input of at most 510 UTF-16 code units is embedded
- **THEN** it is embedded unchanged and no `/tokenize` request is made

#### Scenario: Long input that fits is embedded whole

- **WHEN** an input longer than 510 code units measures at or under 510 content tokens
- **THEN** it is embedded unchanged — no character cap discards content that fits the token budget

#### Scenario: Over-length input is truncated to a verified fit

- **WHEN** an input measures over 510 content tokens
- **THEN** a head-keeping, word-boundary-backed prefix whose re-measured token count is at or under 510 is embedded, and the server never rejects it as over-length

#### Scenario: Measurement failure degrades to the provable bound

- **WHEN** a `/tokenize` request fails or the bounded truncation rounds are exhausted
- **THEN** the provider embeds the input hard-cut at 510 code units and returns a valid embedding — the embed does not fail because measuring failed
