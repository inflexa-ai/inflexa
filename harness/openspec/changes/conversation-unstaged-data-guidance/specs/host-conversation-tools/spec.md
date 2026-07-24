## ADDED Requirements

### Requirement: The conversation prompt orients the agent to host input tools for unstaged data

The conversation agent's prompt SHALL instruct the agent that, when the user references data by name or location that is not yet an input of the analysis, adding it may be available as a host-contributed tool — and if so, to list candidates, confirm with the user, and add them rather than advising the user to copy files into a folder. The guidance SHALL be host-agnostic: it SHALL NOT name a specific host tool or assume one exists, consistent with the seam's invariant that the harness learns nothing domain-specific about host tools. The prompt SHALL NOT assert that data profiling happens only at analysis init; it SHALL reflect that profiling follows the current inputs, including inputs added or removed during the conversation.

#### Scenario: A referenced file that is not an input prompts an offer to add, not a folder-copy

- **WHEN** the user references a data file that is not yet staged as an input
- **THEN** the prompt directs the agent to offer adding it (via a host input tool if one is available) rather than to advise copying files into a folder

#### Scenario: Guidance holds with no host input tool attached

- **WHEN** no host-contributed input tool is attached to the conversation agent
- **THEN** the guidance still holds — the agent says the data must be added as an input — without the prompt naming or assuming any specific tool

#### Scenario: Profiling is not framed as init-only

- **WHEN** inputs are added or removed during the conversation
- **THEN** the prompt does not treat data profiling as a one-time, init-only event
