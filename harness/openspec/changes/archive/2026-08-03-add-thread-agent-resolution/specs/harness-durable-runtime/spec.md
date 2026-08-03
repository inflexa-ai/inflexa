# harness-durable-runtime Specification (delta)

## MODIFIED Requirements

### Requirement: assembleCoreRuntime is the single host-neutral composition root

`assembleCoreRuntime` SHALL be the one assembly point that registers the durable
workflows with DBOS AND builds the conversation agent over the registered
callables, registering that agent in the type-keyed agent registry `CoreRuntime`
exposes as its resolution surface (`agents` — see the thread-agent-resolution
spec); `CoreRuntime` SHALL NOT expose a bare `conversationAgent` field.
Registration order SHALL be preserved because the parent's child
dispatch closes over the registered child callable: the sandbox-step workflow
SHALL register before `executeAnalysis`, which receives that callable. All
workflows SHALL register in this one call before `launchDbos`, so they land under
one `applicationVersion` cohort.

#### Scenario: The parent workflow is built over the registered child callable

- **WHEN** `assembleCoreRuntime` runs
- **THEN** the sandbox-step workflow is registered first
- **AND** `executeAnalysis` is built with the registered sandbox-step callable, not a pre-built one

#### Scenario: The runtime exposes agents only through the resolution surface

- **WHEN** `assembleCoreRuntime` returns
- **THEN** `CoreRuntime` carries the agent resolution surface (`agents`) and the registered workflows
- **AND** the conversation agent is reachable only via `agents.forThread("conversation")`
