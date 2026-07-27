## ADDED Requirements

### Requirement: list_files states its scope in its own description

`list_files`'s `description` SHALL state that the directory it lists belongs to the analysis's own workspace tree, and that the tool never reaches a directory outside the analysis — including the host process's current working directory. This makes the tool self-describing at attach time: an agent SHALL be able to tell, from the description alone, that a question about a directory outside the analysis is not one `list_files` answers, without any prompt-level guidance restating it.

The statement SHALL be context-neutral. `list_files` is attached to sandbox agents as well as the conversation agent, and sandbox agents receive no host-contributed tools, so the description SHALL disclaim the outside scope without asserting that any other tool covers it, and SHALL NOT name or assume a host tool. Which tool — if any — answers for a directory outside the analysis is that tool's own description to claim.

#### Scenario: The description bounds the tool to the analysis tree

- **WHEN** an agent reads `list_files`'s description
- **THEN** it states that the listed directory is part of the analysis's own workspace tree and that the tool never reaches a directory outside the analysis, including the host process's current working directory

#### Scenario: The description names no tool for the outside scope

- **WHEN** the description disclaims directories outside the analysis
- **THEN** it neither names a host-contributed tool nor asserts that one is attached, so the same description is correct for a sandbox agent that has none
