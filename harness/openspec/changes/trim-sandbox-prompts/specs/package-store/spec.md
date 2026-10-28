# Spec Delta

## MODIFIED Requirements

### Requirement: No runtime package installation

The base image MUST NOT bake in analysis packages, and sandbox steps MUST
NOT install packages at runtime — only what the farm links is importable. An
acquisition MUST be a host action.

#### Scenario: Sandbox standards forbid runtime installs

- **GIVEN** a sandbox step whose farm does not link a package
- **WHEN** the step tries to install the package
- **THEN** the install fails, because the sandbox has no egress, and the farm does not change

#### Scenario: A bound link seam routes an absent package through the link tool

- **GIVEN** a composition with the `ExtendAnalysisFarm` seam bound
- **WHEN** the description of `list_available_packages` is inspected
- **THEN** it directs the agent to call `link_packages` before it treats a package as missing
