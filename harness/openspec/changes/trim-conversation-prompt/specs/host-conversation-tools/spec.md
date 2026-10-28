# Spec Delta

## MODIFIED Requirements

### Requirement: The conversation prompt orients the agent to host input tools for unstaged data

The user can name data that is not yet an input of the analysis. For that case, the conversation prompt MUST tell the agent to add the data with a host input tool if it holds one. Without such a tool, the agent says that the data must be added as an input. The prompt MUST NOT tell the agent to advise the user to copy files into a folder.

The prompt MUST NOT tell the agent to confirm the add in text before the call. The host tool asks the user through its approval hook, and a text question first asks the user two times for one change.

The guidance MUST be host-agnostic. It MUST NOT name a specific host tool or assume that one exists, because the harness learns nothing domain-specific about host tools.

The prompt MUST NOT assert that data profiling occurs only at analysis init. It MUST reflect that profiling follows the current inputs, also the inputs that the conversation adds or removes.

#### Scenario: A referenced file that is not an input prompts an offer to add, not a folder-copy

- **WHEN** the user references a data file that is not yet staged as an input
- **THEN** the prompt directs the agent to add it with a host input tool if one is available
- **AND** the prompt does not direct the agent to advise a copy of files into a folder

#### Scenario: Guidance holds with no host input tool attached

- **WHEN** no host-contributed input tool is attached to the conversation agent
- **THEN** the guidance still holds — the agent says the data must be added as an input — without the prompt naming or assuming any specific tool

#### Scenario: Profiling is not framed as init-only

- **WHEN** inputs are added or removed during the conversation
- **THEN** the prompt does not treat data profiling as a one-time, init-only event

#### Scenario: The add asks through the approval of the tool

- **GIVEN** a host input tool with an approval hook
- **WHEN** the user asks to add a named file as an input
- **THEN** the agent calls the tool with no question in the reply text first, and the approval of the tool asks the user
