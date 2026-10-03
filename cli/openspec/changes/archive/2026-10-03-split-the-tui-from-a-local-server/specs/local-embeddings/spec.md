## MODIFIED Requirements

### Requirement: Embedding settings are configured through dialogs in `inflexa config`

The `inflexa config` settings screen SHALL present the embedding configuration as a SINGLE summary row naming the active backend and its distinguishing detail (the built-in model, the custom GGUF's file name, or the api-key model) — NOT as a set of always-visible per-field rows. `embedding.*` is a mode-discriminated union, so the fields belonging to an inactive backend are noise the screen SHALL NOT render. Activating the row SHALL open a backend picker dialog offering four choices — the built-in model, the user's own GGUF, an api-key endpoint, or off — and the chosen backend SHALL determine which follow-up dialogs collect its data. Every dialog SHALL be an existing dialog-system component (`SelectDialog`, `PromptDialog`, `FilePicker`) chained by selection rather than a new bespoke form; cancelling any step SHALL abort the whole change, leaving `config.json` untouched.

Data collection per backend:

- **Built-in model** and **off** SHALL require no follow-up input and apply immediately.
- **The user's own GGUF** SHALL collect the model file path (a file picker) and then its vector width. The width is ENTERED, not measured: this screen SHALL NOT spawn the sidecar — only `inflexa setup` probes a model — so a mistyped width is possible and is deliberately not guarded here.
- **api-key** SHALL collect the key and the base URL, then FETCH the endpoint's model listing (`{baseURL}/models`, narrowed to embedding-capable ids) through the local server (`GET /api/v1/embedding-models`, with the key in a request header and never in the URL), and present the result as a SELECTION rather than free text. A failed, empty, or unusable fetch SHALL fall back to free-text model entry so the flow never dead-ends. An empty key entry SHALL keep the key that the config holds: the server never gives that key to a client, thus the listing cannot run with it, and the flow SHALL go to free-text model entry. The vector width SHALL be collected separately, because the model listing does not carry it.

The screen SHALL read and save the embedding settings through the local server (`GET` and `PATCH /api/v1/settings`), and the server SHALL write `config.json` only — it SHALL NOT acquire, download, or verify a model (that remains `inflexa setup`'s job). The server reads the setting at its boot, thus a change takes effect at the next boot of the local server, where the readiness gate and the profile dimension probe enforce correctness, exactly as for a hand-edited config. The server SHALL give only whether an api key is set, never the key itself. The api key SHALL NOT be printed on the summary row (a remote secret), and its edit prompt SHALL show only a key that the user entered in this screen.

#### Scenario: The screen shows one embedding row, not per-field rows

- **WHEN** the user opens `inflexa config`
- **THEN** exactly one embedding row SHALL be rendered, summarizing the active backend
- **AND** no field belonging to an inactive backend SHALL be rendered

#### Scenario: Choosing the built-in model applies without further input

- **WHEN** the user activates the embedding row and picks the built-in model
- **THEN** config SHALL be set to `mode = "local"` with the built-in model path, with no further prompts

#### Scenario: Choosing your own GGUF collects a path then a width

- **WHEN** the user picks "your own GGUF"
- **THEN** a file picker SHALL collect the model path and a prompt SHALL collect its vector width
- **AND** config SHALL be set to `mode = "local"` with that path and width, with no model spawned or probed

#### Scenario: Choosing api-key fetches the endpoint's models as a selection

- **WHEN** the user picks api-key and supplies a key and base URL
- **THEN** the endpoint's embedding-capable models SHALL be fetched and offered as a selection
- **AND** the vector width SHALL be collected separately

#### Scenario: A failed model fetch falls back to free-text entry

- **WHEN** the model fetch fails, returns nothing, or yields no embedding-capable id
- **THEN** the flow SHALL fall back to free-text model entry rather than dead-ending

#### Scenario: Cancelling a dialog leaves config untouched

- **WHEN** the user cancels any dialog in the chain
- **THEN** no change SHALL be written to `config.json`

#### Scenario: Config edits do not acquire or verify a model

- **WHEN** the user completes a backend change in `inflexa config`
- **THEN** only `config.json` SHALL be written — no model is downloaded, copied, or probed; the readiness gate and profile probe enforce correctness at the next boot of the local server

#### Scenario: The api key is not shown on the summary row

- **WHEN** `embedding.apiKey` is set and the embedding row is rendered
- **THEN** the row SHALL NOT display the key value

#### Scenario: A stored key is kept and never sent to the client

- **GIVEN** a config that holds an api key
- **WHEN** the user opens `inflexa config`, picks api-key, and leaves the key prompt empty
- **THEN** the server keeps the stored key, the client never receives it, and the flow asks for the model id as free text
