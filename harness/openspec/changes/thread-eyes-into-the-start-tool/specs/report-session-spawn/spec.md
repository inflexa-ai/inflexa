## ADDED Requirements

### Requirement: One eyes rule serves the spawn and the tool that runs it
The harness MUST hold one rule that decides whether a composition gives a route to a look. The spawn MUST read that rule, and the start tool MUST read the same rule. The tool MUST NOT hold a second rule of its own. Thus a route that opens the gate of the spawn opens the gate of the tool.

The tool reads the rule for one reason. Its advice costs two database reads, and a closed gate must skip them. The gate of the tool is an optimization, and the refusal itself stays with the spawn.

The tool MUST read the rule over the values that it gives to its own spawn. Thus the gate of the tool answers for the very operation that would refuse.

The obligation binds the composition that the harness assembles. An embedder that builds the tool by hand owns the consistency of the values that it binds.

The assembly MUST resolve the eyes one time. That one answer MUST reach the agent that looks at a page, and it MUST reach the tool that starts the session.

#### Scenario: A bound seam opens the gate of the tool

- **WHEN** the composition binds the eyes seam, it names no browser endpoint, and the agent calls the tool
- **THEN** the tool starts the session, and the thread listing holds the child

#### Scenario: A composition with no route refuses at the tool

- **WHEN** the composition binds no eyes seam, no capture seam, and no browser endpoint
- **THEN** the tool gives the `no_browser` arm, and it runs no advice read

#### Scenario: One resolved seam reaches both consumers

- **WHEN** the assembly resolves the eyes of a composition
- **THEN** the agent that looks at a page and the tool that starts a session read one answer
