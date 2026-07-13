# agent-skill-assignment — delta

> Encodes the **recommended** direction for Decision 2 (option A) from
> `design.md`. If the owner picks a different ownership split, this delta is
> rewritten.

## MODIFIED Requirements

### Requirement: Boot-time skill validation

At startup the harness SHALL verify (via `validateAgentSkills`) that `skillsDir`
exists and that every skill declared by every agent in the catalog resolves to a
readable `SKILL.md`. A declared pack with no readable manifest SHALL fail
validation before the first analysis runs, naming the offending agent and skill.

This check SHALL be invoked from `assembleCoreRuntime` (`runtime/assemble.ts`),
the host-neutral composition point, using the `skillsDir` threaded into it and
the assembled agent catalog — so that a `meta.skills` typo or a `skillsDir` /
image drift fails assembly, not the first analysis. `assembleCoreRuntime`
therefore SHALL require `skillsDir` as an input.

#### Scenario: A typo in meta.skills fails fast

- **GIVEN** an agent declaring a skill whose `SKILL.md` does not exist under `skillsDir`
- **WHEN** `validateAgentSkills` runs at boot
- **THEN** it throws, naming the agent id, the missing skill, and the expected path

#### Scenario: Assembly fails when a declared pack is unreadable

- **GIVEN** `assembleCoreRuntime` is called with a `skillsDir` under which a declared pack has no readable `SKILL.md`
- **WHEN** the runtime assembles
- **THEN** `assembleCoreRuntime` SHALL throw before returning a usable runtime, and no workflow SHALL be registered as available for analysis
