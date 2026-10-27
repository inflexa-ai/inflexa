## MODIFIED Requirements

### Requirement: The chat backend is a user-owned model connection

The user config SHALL carry a top-level `models` block whose `connection` field selects the chat
backend as a mode-discriminated union: `{ mode: "cliproxy", provider? }` (the managed local proxy)
or `{ mode: "direct", provider, baseURL, protocol?, supportsMultiPartToolContent? }` (any user-supplied endpoint). `provider` is
the vendor slug naming the model's provider — an OPEN string vocabulary (e.g. `anthropic`,
`openai`, `google`), a configured FACT in both modes, never derived from a model id. `protocol`
selects the harness provider kind (`"anthropic" | "openai" | "openai-compatible"`); `openai` is the
Responses wire of the OpenAI API. When absent it defaults to `anthropic` for `provider: "anthropic"`,
to `openai` for `provider: "openai"` at the host `api.openai.com`, and to `openai-compatible` otherwise.
`supportsMultiPartToolContent` states that an `openai-compatible` endpoint takes a tool message of parts.
Boot passes it to the harness, which then carries a tool picture to the model. An absent `models`
block SHALL resolve to `{ mode: "cliproxy", provider: "anthropic" }` — behavior identical to the
pre-change CLI. An invalid block SHALL fail closed to the default with a reported config error
(the existing config-schema pattern), never a silent partial parse.

`baseURL` SHALL be a single value every consumer derives from — one configured URL serves both
the chat wire path and any auxiliary request (model listing). Its convention is the protocol's:
for the `anthropic` protocol it is the `/v1`-terminated API root the wire layer appends
`/messages` to (e.g. `https://api.anthropic.com/v1` — the `@ai-sdk/anthropic` convention); for
`openai-compatible` it is the `/v1`-terminated root the wire layer appends `/chat/completions`
to, and for `openai` the same root the wire layer appends `/responses` to. No consumer SHALL assume a different form of the same `baseURL` (e.g. re-appending `/v1`),
and setup's endpoint prompt SHALL state the expected form.

#### Scenario: Absent block reproduces today's behavior

- **WHEN** `config.json` has no `models` block
- **THEN** the connection resolves to cliproxy mode with provider `anthropic`, and boot, chat, and
  provenance behave exactly as before the change

#### Scenario: A direct connection reaches a non-proxy endpoint

- **WHEN** `models.connection` is `{ mode: "direct", provider: "openai", baseURL: "https://api.openai.com/v1" }`
- **THEN** chat traffic targets that endpoint over the Responses protocol and CLIProxyAPI
  is neither required nor contacted by the chat path

#### Scenario: The provider openai at a gateway speaks OpenAI-compatible

- **WHEN** `models.connection` is `{ mode: "direct", provider: "openai", baseURL: "https://gw.corp/v1" }`
- **THEN** chat traffic targets that endpoint over the OpenAI-compatible protocol

#### Scenario: A tool picture reaches the model

- **WHEN** the connection uses the `anthropic` or the `openai` protocol at its endpoint, or the `openai-compatible`
  protocol with `supportsMultiPartToolContent: true`
- **THEN** boot states that the wire carries a tool picture, and the model gets the picture of a tool result

#### Scenario: Protocol override for a gateway

- **WHEN** the connection is `{ mode: "direct", provider: "anthropic", baseURL: <gateway>, protocol: "openai-compatible" }`
- **THEN** the provider identity records `anthropic` while the wire protocol is OpenAI-compatible

#### Scenario: One anthropic baseURL serves chat and listing

- **WHEN** the connection is `{ mode: "direct", provider: "anthropic", baseURL: "https://api.anthropic.com/v1" }`
- **THEN** chat requests target `{baseURL}/messages` and the model listing targets
  `{baseURL}/models` — the same configured value satisfies both, with no second convention

### Requirement: Setup detects and adopts ecosystem provider environment

`inflexa setup`'s direct path SHALL detect the conventional provider environment variables and
offer a pre-filled connection the user confirms, copying only the non-secret fields into
`config.models.connection`. The detection set SHALL be: `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL`
(⇒ provider `anthropic`, protocol `anthropic`) and `OPENAI_API_KEY` / `OPENAI_BASE_URL` (⇒ provider
`openai`, protocol `openai` at the host `api.openai.com` and `openai-compatible` at each other host). The adopted `baseURL` SHALL be normalized to the
`/v1`-terminated form the wire layer requires — appending `/v1` when the path carries no version
segment, and defaulting to the provider's public API root when no `*_BASE_URL` is set — and the
normalized value SHALL be shown as an editable pre-fill the user confirms before it is written.
Only `provider`, `baseURL`, and `protocol` SHALL be written to config; the API key SHALL NOT be
copied (it remains an environment read per "The direct-mode secret comes from the environment
only"). When both ecosystem sets are present, interactive setup SHALL prompt which to adopt.
Adoption is an INTERACTIVE affordance only: under batch resolution (`--yes` or any non-TTY run)
setup SHALL NOT adopt from the environment — the connection facts must be explicit answers, and a
batch direct run without them SHALL fail during upfront validation naming the missing flags and
file keys. Declining the offer SHALL fall through to the existing manual
endpoint/provider/protocol prompts. The CLI SHALL NOT adopt `ANTHROPIC_AUTH_TOKEN` (Anthropic-wire
Bearer auth is out of scope pending a harness capability) nor Bedrock/Vertex environment (no
direct-mode signer).

#### Scenario: Anthropic environment adopted with a normalized baseURL

- **WHEN** the user takes the direct path with `ANTHROPIC_API_KEY` set and
  `ANTHROPIC_BASE_URL=https://api.anthropic.com`
- **THEN** setup offers provider `anthropic`, protocol `anthropic`, and baseURL
  `https://api.anthropic.com/v1` (normalized) as an editable pre-fill; on confirmation
  `config.models.connection` carries exactly those three fields and no key

#### Scenario: Key present but base URL absent defaults to the provider root

- **WHEN** `ANTHROPIC_API_KEY` is set and `ANTHROPIC_BASE_URL` is unset
- **THEN** the offered baseURL defaults to `https://api.anthropic.com/v1` (and symmetrically
  `https://api.openai.com/v1` with protocol `openai` for the OpenAI set)

#### Scenario: OpenAI-compatible environment adopted verbatim

- **WHEN** `OPENAI_API_KEY` is set and `OPENAI_BASE_URL=https://gw.corp/v1`
- **THEN** setup offers provider `openai`, protocol `openai-compatible`, baseURL
  `https://gw.corp/v1` (already `/v1`-terminated, unchanged), copied to config on confirmation

#### Scenario: Both ecosystems present prompts the user

- **WHEN** both `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are set in an interactive setup
- **THEN** setup prompts which provider to adopt before pre-filling the connection

#### Scenario: Batch direct setup requires explicit answers

- **WHEN** `setup --yes --connection direct` runs with `ANTHROPIC_API_KEY` set but no
  `--base-url`/`--provider` answers
- **THEN** nothing is adopted and setup fails upfront naming the missing answers — the env key
  remains only the runtime secret, never a source of connection facts

#### Scenario: The adopted key is never copied to config

- **WHEN** any ecosystem environment is adopted at setup
- **THEN** `config.models.connection` contains `provider`/`baseURL`/`protocol` only, and
  `config.json` contains no API key material

#### Scenario: Declining the offer falls through to manual entry

- **WHEN** a provider environment is detected but the user declines the pre-filled offer
- **THEN** setup runs the existing manual endpoint, provider, and protocol prompts
