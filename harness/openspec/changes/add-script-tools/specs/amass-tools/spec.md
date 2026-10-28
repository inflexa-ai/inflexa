# Spec Delta

## MODIFIED Requirements

### Requirement: The conversation agent and the drug-repurposing agent get the Amass tools

The conversation agent MUST have `search_regulatory_approvals` and `search_patents` as script tools, thus it calls them from `run_script` (refer to the script-tools capability).

`SandboxToolName` MUST have `searchRegulatoryApprovals`, and the sandbox registry MUST map that name to the regulatory tool. `SandboxToolName` MUST NOT have a name for the patent tool. The two tools MUST NOT be members of `BASE_SANDBOX_TOOLS`.

The drug-repurposing agent MUST list `searchRegulatoryApprovals` in `meta.tools`. Its prompt MUST tell it when to use `search_regulatory_approvals`: for the authorization status of a candidate, its approved indications, its designations, and the safety sections of its label.

#### Scenario: The conversation agent has both tools

- **WHEN** the conversation agent is made
- **THEN** its script tools include `search_regulatory_approvals` and `search_patents`, and its tools do not

#### Scenario: The drug-repurposing agent has the regulatory tool only

- **WHEN** the drug-repurposing agent is made
- **THEN** its tools include `search_regulatory_approvals`
- **AND** its tools do not include `search_patents`

#### Scenario: A different sandbox agent does not get the tool

- **WHEN** a sandbox agent does not list `searchRegulatoryApprovals` in `meta.tools`
- **THEN** its tools do not include `search_regulatory_approvals`
