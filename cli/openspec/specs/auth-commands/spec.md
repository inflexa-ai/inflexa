# auth-commands Specification

## Purpose
The `inflexa auth` command group — `login`, `logout`, and `whoami` subcommands that drive the device-authorization flow, revoke-and-delete logout, and local identity inspection, each a thin CLI adapter over the auth-session core.

## Requirements

### Requirement: Auth command registration

The CLI SHALL group authentication under a parent `auth` command, exposing `login`, `logout`, and `whoami` as its subcommands (`inflexa auth login`, `inflexa auth logout`, `inflexa auth whoami`), registered in `src/cli/index.ts`, each lazy-importing its implementation from its own file (`src/modules/auth/login.ts`, `src/modules/auth/logout.ts`, `src/modules/auth/whoami.ts`), matching the existing command pattern. The auth token path SHALL appear in `inflexa --help` via `envDoc`; the `INFLEXA_AUTH0_*` values SHALL NOT (they are internal, baked into release binaries).

#### Scenario: Help output

- **WHEN** the user runs `inflexa --help`
- **THEN** the `auth` command is listed and the Paths section shows the auth token file, while no `INFLEXA_AUTH0_*` variable appears in the Environment section

#### Scenario: Auth subcommand help

- **WHEN** the user runs `inflexa auth --help` (or `inflexa auth` with no subcommand)
- **THEN** `login`, `logout`, and `whoami` are listed as subcommands of `auth`

### Requirement: Login command

`inflexa auth login` SHALL run the device authorization flow: print the verification URL (`verification_uri_complete`) and user code, best-effort open the URL in the default browser (`open`/`xdg-open`/`cmd /c start` by platform; failures ignored silently), poll until completion, persist the tokens, and print a success message with the access token expiry. The printed URL and code SHALL always be shown regardless of whether the browser opened.

#### Scenario: Successful login

- **WHEN** the user runs `inflexa auth login` and approves in the browser
- **THEN** the CLI prints the URL and code, waits, then prints success with the token expiry, and `auth.json` contains access, refresh, and ID tokens

#### Scenario: Missing configuration

- **WHEN** the user runs `inflexa auth login` with any `INFLEXA_AUTH0_*` variable unset
- **THEN** the CLI prints an error naming each missing variable and exits non-zero without any network request

#### Scenario: Authorization denied

- **WHEN** the user clicks "Deny" in the browser
- **THEN** the CLI prints that authorization was denied and exits non-zero, leaving no tokens stored

#### Scenario: Device code expires

- **WHEN** the user never completes the browser step within the code's lifetime
- **THEN** the CLI prints that the code expired and to run `inflexa auth login` again, and exits non-zero

#### Scenario: Re-login while authenticated

- **WHEN** the user runs `inflexa auth login` while already logged in
- **THEN** the flow runs normally and the stored tokens are replaced by the new ones

### Requirement: Logout command

`inflexa auth logout` SHALL first attempt to revoke the stored refresh token at Auth0 (best-effort), then delete the local token file, and SHALL be idempotent — it exits zero even when no tokens are stored or revocation fails. Local credential deletion SHALL never be blocked by revocation failure.

#### Scenario: Successful logout

- **WHEN** a logged-in user runs `inflexa auth logout`
- **THEN** the refresh token is revoked at Auth0, `auth.json` is deleted, and a success message is printed

#### Scenario: Revocation unreachable

- **WHEN** a logged-in user runs `inflexa auth logout` while offline
- **THEN** the CLI prints a warning that server-side revocation failed, still deletes `auth.json`, and exits zero

#### Scenario: Already logged out

- **WHEN** the user runs `inflexa auth logout` with no stored tokens
- **THEN** the CLI prints that no one is logged in and exits zero

### Requirement: Whoami command

`inflexa auth whoami` SHALL operate entirely locally: it decodes the stored ID token's payload (base64url JSON, no signature verification) and prints the user's identity (`sub`, plus `email` and `name` when present) and session status derived from the stored expiry. It SHALL make no network requests.

#### Scenario: Authenticated user

- **WHEN** a logged-in user runs `inflexa auth whoami`
- **THEN** the CLI prints their identity and a session status line, and exits zero

#### Scenario: Access token expired but session renewable

- **WHEN** the stored access token is past expiry but a refresh token is stored
- **THEN** identity is still printed and the status indicates the session will renew on next use

#### Scenario: Not logged in

- **WHEN** the user runs `inflexa auth whoami` with no stored tokens
- **THEN** the CLI prints "Not logged in" with a hint to run `inflexa auth login` and exits non-zero
