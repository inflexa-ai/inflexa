### Requirement: Top-level command registration

The CLI SHALL expose `login`, `logout`, and `whoami` as top-level commands registered in `src/cli/index.ts`, each lazy-importing its implementation from its own file (`src/cli/login.ts`, `src/cli/logout.ts`, `src/cli/whoami.ts`), matching the existing command pattern. The auth token path SHALL appear in `inf --help` via `envDoc`; the `INF_AUTH0_*` values SHALL NOT (they are internal, baked into release binaries).

#### Scenario: Help output

- **WHEN** the user runs `inf --help`
- **THEN** `login`, `logout`, and `whoami` are listed as commands and the Paths section shows the auth token file, while no `INF_AUTH0_*` variable appears in the Environment section

### Requirement: Login command

`inf login` SHALL run the device authorization flow: print the verification URL (`verification_uri_complete`) and user code, best-effort open the URL in the default browser (`open`/`xdg-open`/`cmd /c start` by platform; failures ignored silently), poll until completion, persist the tokens, and print a success message with the access token expiry. The printed URL and code SHALL always be shown regardless of whether the browser opened.

#### Scenario: Successful login

- **WHEN** the user runs `inf login` and approves in the browser
- **THEN** the CLI prints the URL and code, waits, then prints success with the token expiry, and `auth.json` contains access, refresh, and ID tokens

#### Scenario: Missing configuration

- **WHEN** the user runs `inf login` with any `INF_AUTH0_*` variable unset
- **THEN** the CLI prints an error naming each missing variable and exits non-zero without any network request

#### Scenario: Authorization denied

- **WHEN** the user clicks "Deny" in the browser
- **THEN** the CLI prints that authorization was denied and exits non-zero, leaving no tokens stored

#### Scenario: Device code expires

- **WHEN** the user never completes the browser step within the code's lifetime
- **THEN** the CLI prints that the code expired and to run `inf login` again, and exits non-zero

#### Scenario: Re-login while authenticated

- **WHEN** the user runs `inf login` while already logged in
- **THEN** the flow runs normally and the stored tokens are replaced by the new ones

### Requirement: Logout command

`inf logout` SHALL first attempt to revoke the stored refresh token at Auth0 (best-effort), then delete the local token file, and SHALL be idempotent — it exits zero even when no tokens are stored or revocation fails. Local credential deletion SHALL never be blocked by revocation failure.

#### Scenario: Successful logout

- **WHEN** a logged-in user runs `inf logout`
- **THEN** the refresh token is revoked at Auth0, `auth.json` is deleted, and a success message is printed

#### Scenario: Revocation unreachable

- **WHEN** a logged-in user runs `inf logout` while offline
- **THEN** the CLI prints a warning that server-side revocation failed, still deletes `auth.json`, and exits zero

#### Scenario: Already logged out

- **WHEN** the user runs `inf logout` with no stored tokens
- **THEN** the CLI prints that no one is logged in and exits zero

### Requirement: Whoami command

`inf whoami` SHALL operate entirely locally: it decodes the stored ID token's payload (base64url JSON, no signature verification) and prints the user's identity (`sub`, plus `email` and `name` when present) and session status derived from the stored expiry and refresh-token presence. It SHALL make no network requests.

#### Scenario: Authenticated user

- **WHEN** a logged-in user runs `inf whoami`
- **THEN** the CLI prints their identity and a session status line, and exits zero

#### Scenario: Access token expired but session renewable

- **WHEN** the stored access token is past expiry but a refresh token is stored
- **THEN** identity is still printed and the status indicates the session will renew on next use

#### Scenario: Not logged in

- **WHEN** the user runs `inf whoami` with no stored tokens
- **THEN** the CLI prints "Not logged in" with a hint to run `inf login` and exits non-zero
