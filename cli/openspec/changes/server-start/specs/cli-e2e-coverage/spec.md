## MODIFIED Requirements

### Requirement: The server check of an instance command is tested end-to-end
The suite SHALL verify that an instance command with no server to connect to stops before its
action, with the instruction to start a server.

#### Scenario: no server, no action
- **WHEN** the test server is stopped and `inflexa project ls` runs as a subprocess
- **THEN** it exits non-zero and stderr names `inflexa server start`
