# setup-answers delta — hardening

## ADDED Requirements

### Requirement: The answer set is enumerated once

Every answerable question SHALL be declared exactly once, in a single table keyed by the question's config-file key path. The both-spellings rendering, the per-leaf flag-over-file merge, and the coverage guard SHALL derive from (or be statically linked to) that table, and the schema's leaf set SHALL be type-linked to it, so that adding a question to one surface without the others is a compile-time or test failure — an answer that parses SHALL be consumed and spellable. Block-level keys (`connection`, `postgres`, `resources`, `embedding`) SHALL be spellable too, so a block-shaped file error names both spellings like a leaf error does. The CLI flag surface SHALL be pinned by a registry-level test that parses an argv exercising every batch option and asserts each lands in the resolved answers.

#### Scenario: A schema-only answer addition cannot ship silently dropped

- **WHEN** a new answer is added to the answers schema without its table entry, merge handling, or flag mapping
- **THEN** the build or the test suite fails naming the gap, rather than the answer parsing and being silently ignored

#### Scenario: A block-level file error names both spellings

- **WHEN** the config file contains `postgres:` as a null or scalar block
- **THEN** the upfront error names the `postgres` file block together with its flag spellings, not the bare key alone

## MODIFIED Requirements

### Requirement: One answers mechanism resolves every setup question

Setup SHALL define a single answers schema (`SetupAnswers`) covering every interactive decision point of the setup flow — connection mode, direct-connection facts, credential source, model, Postgres fields, resource share, embedding backend and its values, reference selection, sandbox variant, and runtime. Two front-ends populate it: value flags and the `--config` YAML file, resolved per question with the fixed precedence:

```
flag  >  config-file value  >  interactive prompt (TTY and not --yes)  >  default-or-error (--yes or non-TTY)
```

A supplied answer SHALL skip its prompt even in an interactive run, so a partially-filled config file composes with prompts for the remaining questions. A non-TTY run SHALL resolve exactly as `--yes` does. Every persisted value SHALL flow through the same writers the interactive wizard uses — the answers layer changes where values come from, never where they go.

When a MODE-CARRYING flag (`--connection`, `--embeddings`) moves a block's mode away from the file's, the file's leaves that are exclusive to the superseded mode SHALL be dropped from the merged answers and the run SHALL print a note naming each superseded key and the flag that superseded it — an announced drop, never a silent one, and never a hard failure. Mismatches within one source (flag mode against flag leaves, or file mode against file leaves) remain upfront errors: a same-source contradiction is an authoring mistake, not an override.

#### Scenario: A flag overrides the config file

- **WHEN** setup runs with `--config fleet.yml` (carrying `postgres.password: a`) and `--postgres-password b`
- **THEN** the resolved answer for the Postgres password is `b`

#### Scenario: A config file answers questions interactively; prompts fill the gaps

- **WHEN** setup runs on a TTY without `--yes`, with a config file answering the connection and Postgres questions but not embeddings
- **THEN** the connection and Postgres prompts are skipped, and the embedding question is still asked

#### Scenario: Non-TTY resolves like --yes

- **WHEN** setup runs without a TTY and without `--yes`
- **THEN** no prompt is attempted and every question resolves through the same default-or-error path `--yes` uses

#### Scenario: A mode flag supersedes the file's dependent leaves

- **WHEN** `setup --yes --config fleet.yml --embeddings off` runs with the file answering `embedding: {mode: api-key, baseURL: …, model: …}`
- **THEN** the resolved embedding answer is `off`, the run prints a note naming `embedding.baseURL` and `embedding.model` as superseded by `--embeddings off`, and setup succeeds

#### Scenario: A same-source mode mismatch still fails

- **WHEN** `setup --yes --embeddings off --embeddings-url https://gw.corp/v1` runs (both answers from flags)
- **THEN** setup fails upfront naming the mismatch, exactly as an all-file mismatch does

### Requirement: `--yes` never prompts and validates the whole answer set before mutating

Under `--yes`, setup SHALL never prompt — on a TTY or off it. The complete answer set SHALL be validated BEFORE any mutation (config writes, container work, downloads): flag parse errors, config-file schema violations, unknown reference ids (checked against the offered catalog, with already-installed ids valid), URL-shaped answers that do not parse as URLs with a scheme, reserved Postgres ports, contextually-required-but-absent answers, and mode-mismatched answers the resolved modes cannot consume (a direct-only `--base-url` under cliproxy, an `--embeddings-gguf` with api-key embeddings — no answer is ever silently ignored) all fail here, and each error SHALL name both spellings of the answer (the flag and the file key). Validation SHALL report every problem it found in ONE pass — flag-level parse problems and schema-level problems together — so a fleet author fixes the file once, not once per problem class. The two front-ends SHALL accept the same value grammar: a numeric literal the flag front-end rejects (hex, exponent, any non-plain-decimal form) SHALL be rejected from the file too, naming both spellings. Unanswered questions resolve to their defaults: connection `cliproxy`; Postgres per-field defaults (persisting nothing); resource allowance the resolved default (unpersisted); embedding mode unchanged; reference downloads none; sandbox image skipped; model unanswered means Auto in cliproxy mode and an upfront error in direct mode.

#### Scenario: Bare `setup --yes` provisions defaults only

- **WHEN** `inflexa setup --yes` runs with no other answers
- **THEN** the cliproxy stack is provisioned with all-default Postgres, no model pin is written, no reference data or sandbox image is downloaded, and the embedding mode is left unchanged

#### Scenario: Missing required answers fail before any mutation

- **WHEN** `inflexa setup --yes --connection direct` runs without `--base-url`
- **THEN** setup exits non-zero naming `--base-url` / `connection.baseURL`, and no config write, container command, or download has happened

#### Scenario: `--yes` on a TTY does not prompt

- **WHEN** `inflexa setup --yes` runs on an interactive terminal
- **THEN** no prompt is shown for any question (the deliberate break from the earlier refs-consent-only meaning of `--yes`)

#### Scenario: A mode-mismatched answer is rejected

- **WHEN** `inflexa setup --yes --base-url https://gw.corp/v1` runs with the connection resolving to cliproxy
- **THEN** setup fails upfront naming the conflict (a direct-only answer under cliproxy) instead of silently ignoring the answer

#### Scenario: An unknown reference id fails before any mutation

- **WHEN** `inflexa setup --yes --refs collectri,gtex-typo` runs and `gtex-typo` matches nothing in the offered catalog
- **THEN** setup exits non-zero naming `--refs` / `refs` and the unknown id, and no config write, container command, or download has happened

#### Scenario: An already-installed reference id is a valid answer

- **WHEN** `setup --yes --refs <id>` runs a second time after the first run installed `<id>`
- **THEN** upfront validation passes (the id resolves to nothing left to install) and the run completes idempotently

#### Scenario: A base URL answer must be a parseable URL

- **WHEN** `setup --yes --connection direct --base-url gw.corp --provider anthropic --model m --no-validate` runs (no scheme on the URL)
- **THEN** setup fails upfront naming `--base-url` / `connection.baseURL` and requiring a URL with a scheme, before anything is written

#### Scenario: File and flags accept the same numeric grammar

- **WHEN** the config file carries `postgres: {port: 0x1F5B}`
- **THEN** setup fails upfront naming `--postgres-port` / `postgres.port` with the same whole-number rule the flag enforces, instead of accepting the YAML-resolved 8027

#### Scenario: All problems are reported in one pass

- **WHEN** a run supplies a malformed `--postgres-port` and an invalid `--sandbox` value together
- **THEN** the single failure names both problems, not just the first

### Requirement: Batch cliproxy setup is pre-staging

Under batch resolution in cliproxy mode, setup SHALL provision everything except the provider login: proxy config, compose file, images, Postgres, and the answered optional steps. When no provider credential exists in the auth dir, setup SHALL print a notice that the first launch will offer the interactive sign-in and SHALL exit 0 — pre-staging is a legitimate outcome, not a failure. When the run disabled the auth step (`--no-auth`), the sign-in notice SHALL be suppressed: guidance for a step the operator explicitly turned off is noise.

#### Scenario: Pre-staging without a credential succeeds with a notice

- **WHEN** `inflexa setup --yes` completes on a machine whose proxy auth dir holds no credential
- **THEN** the stack is provisioned, a notice names the first-launch sign-in, and the exit code is 0

#### Scenario: `--no-auth` suppresses the sign-in notice

- **WHEN** `inflexa setup --yes --no-auth` completes on a machine whose proxy auth dir holds no credential
- **THEN** the stack is provisioned, no sign-in notice is printed, and the exit code is 0

### Requirement: Validation probes default on; `--no-validate` opts out of network probes

Under batch resolution, the same validations the wizard performs SHALL run by default: the credential-source probe ladder when `auth` is answered, the protocol-shaped 1-token message validation for a direct model answer, and the one-embed endpoint probe for api-key embeddings. Any probe outcome short of a pass — a definite rejection, an unreachable endpoint, or an answer the probe cannot classify — SHALL fail the provision with the endpoint's response shown: batch has no save-anyway confirm, so ambiguity fails hard and `--no-validate` is the sole escape. A probe failure SHALL leave `config.json` untouched — validation precedes persistence, so a rejected answer never strands a partial connection. `--no-validate` SHALL skip the NETWORK probes only — local GGUF verification through the sidecar is offline and SHALL always run. With network probes skipped: a direct model answer persists unvalidated (boot and first chat remain the gate), and api-key embedding dimensions fall back to the width previously configured FOR the api-key backend, else the provider default — a width recorded for a different backend (a local GGUF's measured width) SHALL NOT be adopted — stated in the step's output.

#### Scenario: A bad direct model fails the provision

- **WHEN** `setup --yes --connection direct` runs with validation on and the endpoint answers the model validation with a definite model-not-found
- **THEN** setup exits non-zero showing the endpoint's rejection, and `config.json` is untouched — neither the connection nor a model has been persisted

#### Scenario: --no-validate persists unvalidated

- **WHEN** the same run adds `--no-validate`
- **THEN** the model persists without any validation request, and the run's output states the pick is unvalidated

#### Scenario: Local GGUF verification is never skipped

- **WHEN** `setup --yes --embeddings local --no-validate` runs
- **THEN** the sidecar verification probe of the model still runs (it is offline), and only network probes were skipped

#### Scenario: The assumed width never crosses backends

- **WHEN** `setup --yes --embeddings api-key --embeddings-url https://gw.corp/v1 --no-validate` runs on a machine whose config records a local GGUF's `dimensions: 768`
- **THEN** the persisted api-key configuration assumes the provider-default width, not 768, and the output states the assumption

### Requirement: Secrets never ride answers

No answer — flag or file key — SHALL carry a MODEL or EMBEDDING secret. The direct-connection model key remains an environment read (`INFLEXA_MODEL_API_KEY`, then the provider-conventional variable). The api-key embedding secret SHALL be read from the `INFLEXA_EMBEDDING_API_KEY` environment variable via the sole `process.env` reader, and is REQUIRED (as an env var) when the answers select api-key embeddings under batch resolution; it is persisted to `config.json` exactly as the wizard's masked prompt persists it. Credential-source answers (`auth.*`) are token-free by construction — a variable name, a command string, a scheme — mirroring what `config.json` already stores. `postgres.password` is the ONE answered credential, accepted on both channels as a documented trade-off: it is already stored cleartext in `config.json` for a loopback-only container with well-known defaults, and the file spelling is the recommended channel for anyone who minds argv visibility. No error message or output SHALL ever echo an answered password or any secret value.

#### Scenario: Batch api-key embeddings without the env var fails upfront

- **WHEN** `setup --yes --embeddings api-key --embeddings-url https://api.openai.com/v1` runs with `INFLEXA_EMBEDDING_API_KEY` unset
- **THEN** setup fails during upfront validation naming the variable, before any provisioning

#### Scenario: An answered password is consumed without ever being echoed

- **WHEN** a run answers `postgres.password` (by flag or file) and any validation problem is reported
- **THEN** the password value appears in no error message, notice, or next-steps output (masked where the connection string is shown)
