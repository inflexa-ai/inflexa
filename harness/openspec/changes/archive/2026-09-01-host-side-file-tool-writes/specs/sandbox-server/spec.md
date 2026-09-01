## MODIFIED Requirements

### Requirement: Submit-and-return exec semantics

The sandbox-server MUST accept `POST /exec` with a JSON body of
`{ command, execId, cwd?, env?, timeoutSeconds? }`. It MUST spawn the command
in a background goroutine, and it MUST return HTTP 202 immediately with
`{ "execId": <execId>, "status": "started" }`. The HTTP response body MUST NOT
carry stdout, stderr, exit, or any streamed command output. The request
handler MUST return before the spawned command completes.

The server MUST cap the request body that it buffers at a fixed, generous
limit. The limit is generous because the former write path of `write_file`
shipped whole files base64-inflated inside the command array. The server MUST
reject a larger body with HTTP 413, and it MUST spawn nothing. The server
reads the body before it can make sure of the signature, because the signature
covers the bytes. Thus the cap, not the auth check, bounds the memory cost of
an unauthenticated peer that can reach the port.

#### Scenario: Submit returns 202 before command exits

- **GIVEN** a sandbox-server is up and reachable
- **WHEN** `POST /exec` is called with body `{ "command": ["sleep", "10"], "execId": "wf1:step1:fn1" }`
- **THEN** the server MUST respond with HTTP 202 and body `{ "execId": "wf1:step1:fn1", "status": "started" }` within 1 second
- **AND** the response MUST complete before the `sleep` command exits

#### Scenario: Missing execId is rejected

- **WHEN** `POST /exec` is called with body `{ "command": ["echo", "hi"] }` (no `execId`)
- **THEN** the server MUST respond with HTTP 400 and body `{ "error": "execId required" }`
- **AND** no command MUST spawn

#### Scenario: Submit body schema validation

- **WHEN** `POST /exec` is called with a malformed JSON body
- **THEN** the server MUST respond with HTTP 400 and MUST NOT spawn a command

#### Scenario: Oversized submit is rejected

- **WHEN** `POST /exec` arrives with a body that exceeds the server's cap
- **THEN** the server MUST respond HTTP 413 and MUST NOT spawn a command
