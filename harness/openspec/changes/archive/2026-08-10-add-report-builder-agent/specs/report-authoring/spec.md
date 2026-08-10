## ADDED Requirements

### Requirement: The title operation
The tool surface MUST give a title operation that sets the title of the whole document. The operation loads, persists, and reports through the same path as the block operations. The title of the document is not the title of a section.

#### Scenario: The title lands
- **WHEN** the agent sets the title of the draft
- **THEN** the document holds the title, and the result carries `applied: true` with an empty changed list

## MODIFIED Requirements

### Requirement: The authoring tool surface
The operations MUST ship as harness tools, made with `defineTool` through one factory. The factory closes over a session-state gateway and reads no other ambient state. A tool MUST read the thread id from the scope of the call, and it MUST load the state through the gateway. A landed document MUST persist before the tool reports. A call whose scope carries no thread id MUST refuse as typed data in the ok channel.

#### Scenario: The factory packages the tools
- **WHEN** a caller gives the factory a session-state gateway
- **THEN** the caller gets the authoring tools, and each tool operates on the state of its own thread only

#### Scenario: A landed operation persists before the report
- **WHEN** an add operation lands on a thread
- **THEN** the gateway holds the new document before the tool result reports `applied: true`

#### Scenario: Two threads stay isolated through one factory
- **WHEN** two threads each add a block through one factory
- **THEN** the outline of each thread holds only its own block
