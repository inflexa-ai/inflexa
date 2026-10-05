## ADDED Requirements

### Requirement: Citation resolution is a registered sandbox tool name

`SandboxToolName` and the exhaustive shared-tool resolver SHALL include `resolve_citation`. A sandbox agent SHALL be able to declare that name in its required `AgentMeta.tools` array and receive the same resolver-backed tool used by host agents. The registry SHALL continue to reject unknown names at composition time.

#### Scenario: Sandbox metadata requests citation resolution

- **WHEN** a sandbox agent definition includes `resolve_citation` in its tool allowlist
- **THEN** composition resolves the name to the shared citation-resolution tool

#### Scenario: Registry exhaustiveness includes the new name

- **WHEN** the master `SandboxToolName` set is compared with the resolver implementation
- **THEN** `resolve_citation` is present in both and no fallback branch accepts unknown names
