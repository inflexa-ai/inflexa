# per-agent-tool-allowlist Specification

## Purpose

Every sandbox agent declares the subset of research / bio-lookup tools it needs
in its `AgentMeta.tools` (a `SandboxToolName[]`). The composition root
`createSandboxAgent` (`src/agents/sandbox/shared.ts`) resolves that allowlist
against an internal registry via the private `resolveSandboxTools(deps, tools)`
helper, then wires the resolved set alongside the always-on workspace substrate.
The `SandboxToolName` union is the closed set of names an agent may declare, so
a meta that references a tool with no implementation fails at **composition
time**, not at first LLM call.

Env-gated tools (`searchDisgenet`, `searchDrugbank`, `searchToxcast`,
`searchCtxHazard`, `searchCtxChemical`, `searchCtxExposure`, plus the NCBI
literature tools) are built **unconditionally** from `deps.bioKeys`; their key
slice may be empty. A missing key is not detected at resolution — the tool is
still present in the agent's tool array. The underlying header builder throws on
the **first call**, which the loop wraps as a `tool_result { is_error: true }`
envelope. Tools are therefore never silently omitted, and the allowlist never
collapses to an empty array because a key is unset.

## Requirements

### Requirement: Tool registry as master set

`resolveSandboxTools` SHALL build a registry mapping every `SandboxToolName` to a
concrete `Tool` (a pure leaf or a fully dep-bound factory output). The
`SandboxToolName` union SHALL be the closed set of keys the registry recognises
and the element type of `AgentMeta.tools`. The registry SHALL include the
env-gated tools (`searchDisgenet`, `searchDrugbank`, `searchToxcast`,
`searchCtxHazard`, `searchCtxChemical`, `searchCtxExposure`) unconditionally.

#### Scenario: Registry contains every named tool

- **WHEN** the resolver builds its registry
- **THEN** every `SandboxToolName` key maps to a concrete `Tool`
- **AND** the env-gated tools are present whether or not their API key is set

#### Scenario: SandboxToolName type matches registry keys

- **WHEN** a value of type `SandboxToolName` is used in a meta's `tools` array
- **THEN** TypeScript enforces it is one of the registry's key names

### Requirement: Env-gated tools are registered unconditionally

The resolver SHALL register every env-gated tool regardless of whether its API
key is present. A missing key SHALL NOT omit the tool nor shorten the resolved
array; the absence surfaces only when the tool is called, as a
`tool_result { is_error: true }` from the loop's tool-error boundary.

#### Scenario: Env-gated tool resolved when key absent

- **WHEN** an agent declares `searchToxcast` and no EPA CompTox key is configured
- **THEN** `searchToxcast` is present in the agent's resolved tool array

#### Scenario: Missing key surfaces as is_error at call time

- **WHEN** the agent calls `searchToxcast` and no EPA CompTox key is configured
- **THEN** the header builder throws on that call
- **AND** the loop wraps it as a `tool_result { is_error: true }` rather than omitting the tool

#### Scenario: Env-gated tool works when key present

- **WHEN** the agent calls `searchToxcast` with the EPA CompTox key configured
- **THEN** the call proceeds normally and returns its data result

### Requirement: Unknown tool names fail at composition time

`resolveSandboxTools` SHALL throw when `meta.tools` names a `SandboxToolName` with
no registry entry, so a misconfigured agent fails at startup rather than at its
first LLM call.

#### Scenario: Unknown tool name throws during agent construction

- **WHEN** `createSandboxAgent` is invoked with a meta whose `tools` names a tool with no implementation
- **THEN** construction throws an error naming the offending tool
- **AND** no agent definition is produced

### Requirement: AgentMeta.tools is a required SandboxToolName array

`AgentMeta` (`src/agents/sandbox/types.ts`) SHALL include a required
`tools: readonly SandboxToolName[]` field, and every sandbox-agent meta SHALL
declare a non-empty `tools` array.

#### Scenario: AgentMeta type requires tools

- **WHEN** the `AgentMeta` interface is inspected
- **THEN** `tools: readonly SandboxToolName[]` is present and non-optional

#### Scenario: Every agent meta declares tools

- **WHEN** the entries of `SANDBOX_AGENT_META` are inspected
- **THEN** every entry has a non-empty `tools` array

### Requirement: createSandboxAgent wires the allowlist plus the always-on substrate

`createSandboxAgent(deps, meta, body, opts?)` SHALL resolve `meta.tools` via
`resolveSandboxTools` and add the result to the agent's tools alongside the
always-on substrate: the workspace read tools, the workspace mutate tools
(omitted in read-only mode), the per-agent skill tools, and `report_blocker`
when a blocker holder is supplied. `BASE_SANDBOX_TOOLS` is part of the allowlist
each meta spreads into its own `tools`, not an auto-injected extra.

#### Scenario: Agent with only the base set receives base plus substrate

- **GIVEN** a meta whose `tools` is exactly `BASE_SANDBOX_TOOLS`
- **WHEN** `createSandboxAgent(deps, meta, body)` is invoked
- **THEN** the agent's tool array contains the five base tools plus the always-on workspace substrate
- **AND** no other research / bio-lookup tools are present

#### Scenario: Agent with extra declared tools receives them all

- **GIVEN** a meta whose `tools` declares the ChEMBL family alongside the base set
- **WHEN** `createSandboxAgent(deps, meta, body)` is invoked
- **THEN** the agent's tool array contains every declared tool plus the workspace substrate
