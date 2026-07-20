# host-conversation-tools Specification

## Purpose

Define the harness's embedder-contributed conversation-tool seam: how a host supplies additional `Tool`s to the conversation agent, how they are appended to the built-in roster, and the invariant that the harness dispatches them identically to built-ins and learns nothing domain-specific about them. The seam lets an embedder expose host-specific capabilities (e.g. driving its own CLI) as conversation tools without the harness depending on the embedder, keeping the product core host-agnostic.

## Requirements

### Requirement: The conversation agent accepts embedder-contributed tools

`ConversationAgentDeps` SHALL expose an optional `hostTools: readonly Tool[]` seam, threaded through `ConversationAssemblyDeps`. `createConversationAgent` SHALL append the supplied host tools to its built-in tool roster so the agent's tool set is the built-ins followed by the host tools. When no `hostTools` is supplied, the roster SHALL be exactly the built-ins, unchanged. The harness SHALL NOT inspect, branch on, or otherwise learn anything domain-specific about a host tool — a host tool is an ordinary `Tool` value the embedder constructs.

#### Scenario: A host tool joins the roster

- **GIVEN** a `ConversationAgentDeps` whose `hostTools` contains one tool
- **WHEN** `createConversationAgent` builds the agent
- **THEN** that tool is present in the agent's tools alongside every built-in tool

#### Scenario: Omitting host tools leaves the built-in roster unchanged

- **GIVEN** a `ConversationAgentDeps` with no `hostTools`
- **WHEN** `createConversationAgent` builds the agent
- **THEN** the agent's tools are exactly the built-in roster

### Requirement: Host tools are dispatched identically to built-in tools

A host tool SHALL be constructed with the same `defineTool` primitive as any built-in and SHALL receive the same `ToolContext` at `execute` — including the `ask` user-approval seam and the `runStep` durability seam. The agent loop SHALL dispatch a host tool through the same path and the same error contract as a built-in: expected outcomes are `ok` data variants, unexpected failures are `err(ToolError)` or a throw the loop maps to a model-visible error result. The harness SHALL NOT grant a host tool any capability a built-in conversation tool lacks, and SHALL NOT add a host tool to any sandbox agent's tool set.

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
