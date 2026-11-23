## Purpose

The MCP sign-in runs the OAuth flow of a remote MCP server. It keeps the tokens out of the config, in the places that Claude Code uses for its credentials.

## ADDED Requirements

### Requirement: The user signs in to a server with a command

`inflexa mcp auth <name>` MUST run the OAuth flow of the server in the browser. The CLI MUST give the harness an `OAuthClientProvider` that reads the stored tokens.

#### Scenario: A first sign-in

- **GIVEN** an `http` server with `auth: "oauth"` and no stored token
- **WHEN** the user runs `inflexa mcp auth <name>` and approves in the browser
- **THEN** the CLI stores the tokens, and the next agent call to the server carries the access token

### Requirement: The client shows the authorization URL and takes a pasted callback

The local server runs the sign-in, but it MUST NOT open a browser. `POST /api/v1/mcp/:name/auth` MUST answer with an SSE stream. The first frame MUST give the authorization URL and the loopback callback URL. The last frame MUST give the outcome. A refusal before the sign-in starts MUST stay a JSON error body with its status.

The command MUST print the authorization URL, and then open it in the default browser. When no browser opens, the command MUST name the browser setting (`INFLEXA_BROWSER`, or the config key `browser`). With the value `never`, the command MUST NOT try a browser. When `SSH_CONNECTION` is set, the command MUST print the `ssh -L` command for the callback port. When stdin is a terminal, the command MUST accept a pasted callback URL, and it MUST send the same `GET` request to the callback port of this machine.

#### Scenario: A sign-in through SSH

- **GIVEN** the user runs `inflexa mcp auth <name>` on a remote machine through SSH
- **WHEN** the browser on the computer of the user cannot reach the callback, and the user pastes the URL from the address bar
- **THEN** the command sends the request to the callback port of the remote machine, and the sign-in completes

### Requirement: Tokens are stored per endpoint outside the config

The CLI MUST store the tokens and the client registration of a server under the URL of its endpoint. On macOS, the CLI MUST use the Keychain. If the Keychain refuses the write, the CLI MUST use a `0600` file under `~/.local/share/inflexa/`. On Linux and Windows, the CLI MUST use that file. The CLI MUST NOT write a token into `config.json`.

#### Scenario: A locked Keychain

- **GIVEN** a macOS session whose Keychain refuses the write
- **WHEN** the sign-in completes
- **THEN** the tokens are in the `0600` file, and the next call reads them

#### Scenario: A copied config entry needs its own sign-in

- **GIVEN** a server entry copied to a new name with a different URL
- **WHEN** an agent calls the new server
- **THEN** the call has no token until the user signs in to the new server

### Requirement: Logout revokes and removal deletes

`inflexa mcp logout <name>` MUST revoke the tokens where the server supports revocation, and it MUST delete them. `inflexa mcp rm <name>` MUST delete the tokens, the client registration and the config entry.

#### Scenario: Remove a server

- **WHEN** the user runs `inflexa mcp rm lims`
- **THEN** no token, client registration or config entry of `lims` remains
