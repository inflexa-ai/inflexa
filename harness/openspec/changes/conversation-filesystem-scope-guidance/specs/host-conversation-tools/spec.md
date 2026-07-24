## ADDED Requirements

### Requirement: The conversation prompt distinguishes the analysis tree from directories outside it

The conversation agent's prompt SHALL orient the agent that its workspace file tools (`workspace_search`, `read_file`, `list_files`, `grep`) see ONLY the analysis's own workspace tree and cannot see any directory outside it, including the folder the user launched the host from (their shell's current working directory).

The prompt SHALL instruct the agent that a question about "the current directory", "this folder", "the cwd", or "where the user launched / started from" is AMBIGUOUS between those two scopes, and that the agent SHALL NOT silently answer only the workspace interpretation. When the agent answers such a question from the analysis tree, the prompt SHALL direct it to say so and, in the same turn, offer the other scope — which a host-contributed tool may be able to list. When the phrasing points squarely at the outside folder, the prompt SHALL direct the agent to reach for that host tool first rather than the workspace file tools.

The guidance SHALL be host-agnostic: it SHALL NOT name a specific host tool or assume one is attached, consistent with the seam's invariant that the harness learns nothing domain-specific about host tools.

#### Scenario: An ambiguous "cwd" question surfaces both scopes

- **WHEN** the user asks what files are "in the cwd" (or "this folder", "the current directory")
- **THEN** the prompt directs the agent not to answer only from the analysis tree, but to name which scope it listed and offer the other scope in the same turn

#### Scenario: A question pointing at the launch folder routes outside the workspace

- **WHEN** the user's phrasing points squarely at the folder they launched the host from ("where I ran the program", "my working directory")
- **THEN** the prompt directs the agent to reach for a host tool that can list that outside folder rather than the workspace file tools

#### Scenario: Guidance names no specific host tool

- **WHEN** the prompt describes listing the folder outside the analysis tree
- **THEN** it refers to a host-contributed tool generically and neither names a specific tool nor assumes one is attached
