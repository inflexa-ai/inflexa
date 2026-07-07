# analysis-lock Specification (delta)

## ADDED Requirements

### Requirement: Deliberate harness commands hold the analysis lock

The per-analysis instance lock SHALL be acquired not only by the TUI open flow but by
every deliberate command that boots the embedded runtime against an analysis —
`inflexa run`, `inflexa profile`, and `inflexa chat` — after the analysis is resolved
and before the runtime boots or any state is mutated. A conflict SHALL print a message
naming the analysis and the fact that another instance holds it, and exit non-zero
without booting. This makes every provenance-emitting surface on one analysis
single-process for its duration (the interim two-recorder fix of #37; the daemon
architecture closes it structurally later). The lock SHALL be released through the
same exit paths the TUI uses, and the existing pid-liveness reclaim and
ownership-checked release requirements apply unchanged to these holders.

#### Scenario: A command on a free analysis proceeds

- **WHEN** `inflexa run`, `profile`, or `chat` targets an analysis no live instance holds
- **THEN** the lock is acquired under the analysis id and the command proceeds to boot

#### Scenario: A command on a held analysis is refused

- **WHEN** a command targets an analysis already held by a live TUI or command process
- **THEN** it prints the conflict to stderr and exits non-zero before booting the runtime

#### Scenario: Command exit releases the lock

- **WHEN** a lock-holding command finishes (success, failure, or detach)
- **THEN** the lock is released through the exit hook and a subsequent command can acquire it
