## MODIFIED Requirements

### Requirement: Host tools are dispatched identically to built-in tools

A host tool SHALL be constructed with the same `defineTool` primitive as any built-in and SHALL receive the same `ToolContext` at `execute` — including the `ask` user-approval seam. The context carries no durability seam. The agent loop SHALL dispatch a host tool through the same path and the same error contract as a built-in: expected outcomes are `ok` data variants, unexpected failures are `err(ToolError)` or a throw the loop maps to a model-visible error result. The harness SHALL NOT grant a host tool any capability a built-in conversation tool lacks, and SHALL NOT add a host tool to any sandbox agent's tool set.

#### Scenario: A host tool raises an approval through the shared context

- **GIVEN** a host tool whose `execute` calls `ctx.ask(request)`
- **WHEN** the tool is dispatched on an interactive turn
- **THEN** the ask is surfaced and resolved through the same approval seam a built-in tool would use

#### Scenario: A host tool is denied by default off an interactive surface

- **GIVEN** a host tool that calls `ctx.ask` on a turn where the embedder wired no `ask` realization
- **WHEN** the tool is dispatched
- **THEN** the ask is denied by the deny-by-default realization rather than left waiting

#### Scenario: Host tools do not reach sandbox agents

- **GIVEN** an embedder that supplies `hostTools` to the conversation agent
- **WHEN** a sandbox agent is constructed
- **THEN** no host tool appears in the sandbox agent's tool set

