# agent-skill-assignment — delta

> Decision 2 (boot ownership) resolved: the harness owns an ordered boot
> sequence (`bootHarness`, `runtime/boot.ts`) that runs `validateAgentSkills`
> before DBOS launch. `assembleCoreRuntime` stays sync and pure.

## MODIFIED Requirements

### Requirement: Boot-time skill validation

At startup the harness SHALL verify (via `validateAgentSkills`) that `skillsDir`
exists and that every skill declared by every agent in the catalog resolves to a
readable `SKILL.md`. A declared pack with no readable manifest SHALL fail
validation before the first analysis runs, naming the offending agent and skill.

This check SHALL be invoked from the harness-owned boot sequence
`bootHarness` (`runtime/boot.ts`), using the `skillsDir` the embedder threads in
and the harness-owned agent catalog (`SANDBOX_AGENT_META`). It SHALL run before
DBOS launch — after the injected telemetry init and before state init, the
connection-budget guard, `assembleCoreRuntime`, and `launchDbos` — so a
`meta.skills` typo or a `skillsDir` / image drift fails in milliseconds, before
any Postgres or DBOS cost is paid. `bootHarness` therefore SHALL require
`skillsDir` as an input.

#### Scenario: A typo in meta.skills fails fast

- **GIVEN** an agent declaring a skill whose `SKILL.md` does not exist under `skillsDir`
- **WHEN** `validateAgentSkills` runs at boot
- **THEN** it throws, naming the agent id, the missing skill, and the expected path

#### Scenario: Boot fails on an unreadable pack before any launch work

- **GIVEN** `bootHarness` is called with a `skillsDir` under which a declared pack has no readable `SKILL.md`
- **WHEN** the harness boots
- **THEN** `bootHarness` SHALL reject before state init, the connection-budget guard, and `launchDbos` run, so no durable engine is launched
