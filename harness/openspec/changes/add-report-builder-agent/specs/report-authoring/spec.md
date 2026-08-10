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
