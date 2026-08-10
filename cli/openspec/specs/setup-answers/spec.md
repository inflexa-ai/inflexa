# setup-answers Specification

## Purpose
The non-interactive setup contract: the `SetupAnswers` mechanism through which `inflexa setup --yes`
(batch mode) and `--config` (the YAML answers file) resolve every interactive decision of the setup
flow — the resolution precedence, strict file parsing, upfront whole-set validation, batch defaults,
validation probes, and idempotency. Created by archiving change non-interactive-setup.
## Requirements

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

### Requirement: `--config` is a strict YAML answers file

`--config <path>` SHALL load a YAML answers file parsed with the runtime's native YAML support (no new dependency). A missing, unreadable, or unparseable file SHALL fail upfront naming the path and the parse failure. Parsing is STRICT: an unknown key SHALL be an error naming that key — the file is authored intent, where a typo'd key silently skipping a step is the worst fleet failure. The file's content SHALL be extracted into the answers schema and consumed from there only; no file content is ever merged or copied verbatim into `config.json`. The file SHALL carry configuration answers only — execution modifiers (`--yes`, `--no-start`, `--no-postgres`, `--force`, `--no-validate`, `--no-auth`) are flag-only and SHALL NOT be file keys. `--config` and `--yes` are orthogonal: the file is an answer source, `--yes` is the no-prompt guarantee.

#### Scenario: A missing or unparseable file fails upfront

- **WHEN** setup runs with `--config ./fleet.yml` and the file is absent or not valid YAML
- **THEN** setup fails before any mutation naming the path and the parse failure

#### Scenario: An unknown key is rejected

- **WHEN** the config file contains `embedings: {mode: local}` (typo)
- **THEN** setup fails upfront naming the unknown key `embedings`, and nothing is provisioned

#### Scenario: An execution modifier in the file is rejected

- **WHEN** the config file contains `start: false`
- **THEN** setup fails upfront naming `start` as an unknown key (invocation behavior is flag-only)

#### Scenario: File values reach config.json only through extraction

- **WHEN** a config file answers the direct connection and setup completes
- **THEN** `config.json`'s `models.connection` block was written by the same writer the wizard uses, from the extracted answers — never by copying file content

### Requirement: `--provider` wears the vocabulary of the connection mode

The `--provider` answer (file: `connection.provider`) SHALL be interpreted by the resolved connection mode: in `cliproxy` mode it is the OAuth account kind (`gemini|openai|claude|qwen|iflow`), valid only where the OAuth flow can run — an interactive run; in `direct` mode it is the open vendor slug written to `models.connection.provider`. Under `--yes` (or non-TTY) with cliproxy mode, a provider answer SHALL be rejected during upfront validation with an error explaining that provider OAuth cannot run unattended and that the first launch offers the sign-in.

#### Scenario: Batch cliproxy rejects a provider answer

- **WHEN** `inflexa setup --yes --provider claude` runs (connection defaulting to cliproxy)
- **THEN** setup fails upfront explaining OAuth cannot run non-interactively and pointing at the first-launch sign-in

#### Scenario: Direct mode takes the provider as a vendor slug

- **WHEN** `inflexa setup --yes --connection direct --base-url https://gw.corp/v1 --provider deepseek --model d1` runs
- **THEN** `models.connection.provider` is written as `deepseek` (open vocabulary, no account-kind validation)

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

### Requirement: The sandbox image and resource allowance are answerable

`--sandbox` (file: `sandbox`) SHALL answer whether setup obtains the container
images and the package store catalog. The answer IS the multi-GB consent, and each
transfer then runs with no size confirmation. The answer SHALL NOT name an image
variant, because one runtime image is published and the store carries the package
set.

A pull SHALL obtain both the runtime image and the provisioner image. The store is
the one source of an R library and a Python library, and the provisioner extends
it.

The answer SHALL cover one bundle of three transfers:

- the runtime image
- the provisioner image
- the package store catalog

Setup SHALL list the three items in one message. The user SHALL answer one time,
and that one answer SHALL cover the whole bundle. Setup SHALL ask no second
consent for the catalog.

There SHALL be no answer that takes the two images and refuses the catalog. The
store is mandatory, and no runtime image bakes a library. Thus a sandbox with no
catalog can import nothing, and a partial answer has no working result.

When the answer is yes, setup SHALL start the detached store downloader at the
moment that it starts the image pulls. The catalog transfers while the images
pull. Setup SHALL NOT wait for the catalog, and it SHALL name the command that
reports the progress. `lib-store-download-process` owns the lifecycle of that
process.

Setup SHALL exit when the image pulls finish. The catalog transfer SHALL continue
after that exit, because the downloader is a detached process.

When the user answers no in an interactive run, setup SHALL record the download
state as `declined`. The app SHALL NOT ask that question again at app open, and
`inflexa store download` SHALL stay the way to start the transfer later.

Absent an answer, batch setup SHALL skip both images and SHALL start no download.
The existing pull-later hint SHALL name the command for the images and the command
for the catalog. Nothing SHALL download implicitly.

An answer that names a retired variant SHALL fail validation in the one up-front
pass, and the error SHALL name both spellings of the answer. It SHALL say that the
variant is retired and that the answer takes no image name.

`resources.sharePct` (flag `--resource-share <pct>`, 1 to 100) SHALL answer the
machine-allowance question as a percentage, which is portable across heterogeneous
fleets. The CLI SHALL persist the absolute budget that it computes from the
detected machine, exactly as the prompt of the wizard persists it.

#### Scenario: A sandbox answer pulls and downloads without confirmation

- **WHEN** `setup --yes --sandbox` runs with the images absent locally
- **THEN** the runtime image and the provisioner image are pulled with no size prompt, and the detached store download starts

#### Scenario: Setup does not wait for the store transfer

- **GIVEN** `setup --yes --sandbox` that started the store download
- **WHEN** the setup command finishes
- **THEN** setup exits, it names the command that reports the progress, and the transfer continues

#### Scenario: One answer covers the whole bundle

- **WHEN** `setup --sandbox` runs interactively
- **THEN** setup lists the two images and the catalog in one message, and the user answers one time

#### Scenario: No answer takes the images and refuses the catalog

- **WHEN** the user looks for a way to accept the images and refuse the catalog
- **THEN** no such answer exists, because the store is mandatory

#### Scenario: The catalog transfers while the images pull

- **WHEN** `setup --sandbox` starts the two image pulls
- **THEN** the detached catalog downloader starts at the same moment, and the two transfers run together

#### Scenario: No sandbox answer downloads nothing

- **WHEN** `setup --yes` runs without `--sandbox`
- **THEN** no image is pulled, no store download starts, and the pull-later hint names both commands

#### Scenario: A refusal records the declined state

- **GIVEN** an interactive `inflexa setup`
- **WHEN** the user answers no to the images and the catalog
- **THEN** the download state is `declined`, no process starts, and the app asks nothing at its next open

#### Scenario: A retired variant answer fails validation

- **WHEN** `setup --yes --sandbox python-r` runs
- **THEN** validation fails before any mutation, names both spellings of the answer, and says the answer takes no image name

#### Scenario: The resource share persists machine-relative absolutes

- **WHEN** `setup --yes --resource-share 50` runs
- **THEN** the persisted budget is the absolute value computed from the detected machine, exactly as the prompt of the wizard persists it

### Requirement: Batch setup is idempotent

Re-running batch setup with the same answers SHALL converge to the same final state without destructive or duplicate work: an existing proxy config is left untouched, the compose file is regenerated, images and datasets already present are not re-fetched, the vector extension install is a no-op, and persist-only-explicit config writes rebuild to the same content.

#### Scenario: A second identical run changes nothing

- **WHEN** `setup --yes --config fleet.yml` runs twice on the same machine
- **THEN** the second run completes successfully with no re-downloads and a byte-identical resulting configuration

### Requirement: The answer set is enumerated once

Every answerable question SHALL be declared exactly once, in a single table keyed by the question's config-file key path. The both-spellings rendering, the per-leaf flag-over-file merge, and the coverage guard SHALL derive from (or be statically linked to) that table, and the schema's leaf set SHALL be type-linked to it, so that adding a question to one surface without the others is a compile-time or test failure — an answer that parses SHALL be consumed and spellable. Block-level keys (`connection`, `postgres`, `resources`, `embedding`) SHALL be spellable too, so a block-shaped file error names both spellings like a leaf error does. The CLI flag surface SHALL be pinned by a registry-level test that parses an argv exercising every batch option and asserts each lands in the resolved answers.

#### Scenario: A schema-only answer addition cannot ship silently dropped

- **WHEN** a new answer is added to the answers schema without its table entry, merge handling, or flag mapping
- **THEN** the build or the test suite fails naming the gap, rather than the answer parsing and being silently ignored

#### Scenario: A block-level file error names both spellings

- **WHEN** the config file contains `postgres:` as a null or scalar block
- **THEN** the upfront error names the `postgres` file block together with its flag spellings, not the bare key alone

### Requirement: A second `inflexa setup` never blocks on a live catalog download

`inflexa setup` SHALL complete each of its steps while a catalog download runs. A
live transfer SHALL block no step of setup.

Setup does many things, for example the references, the database, and the model
configuration. Each of those steps SHALL run to its end during a transfer.

At its store step, a second setup SHALL open no consent. The first answer stands,
thus setup asks that question one time only.

The store step SHALL report the live transfer. It SHALL name the state, and it
SHALL name the bytes transferred and the total bytes.

The store step SHALL name `inflexa store cancel`, which stops the transfer. It
SHALL name `inflexa sandbox remove`, which removes the two pulled images. The user
owns the two decisions, and setup makes neither one.

Setup SHALL then continue to the remaining steps. It SHALL NOT wait for the
transfer, and the held lock SHALL make it start no second downloader.

#### Scenario: A second setup opens no consent for the catalog

- **GIVEN** a live catalog download
- **WHEN** `inflexa setup` runs a second time
- **THEN** the store step opens no consent, because the first answer stands

#### Scenario: A second setup reports the live transfer

- **GIVEN** a live catalog download
- **WHEN** `inflexa setup` reaches its store step
- **THEN** it names the state, the bytes transferred, and the total bytes

#### Scenario: A second setup names the two commands

- **GIVEN** a live catalog download
- **WHEN** `inflexa setup` reaches its store step
- **THEN** it names `inflexa store cancel` and `inflexa sandbox remove`

#### Scenario: The live transfer blocks no other step

- **GIVEN** a live catalog download
- **WHEN** `inflexa setup` runs a second time
- **THEN** the references, the database, and the model configuration each complete, and setup exits

#### Scenario: A second setup starts no second downloader

- **GIVEN** a live catalog download that holds the lock
- **WHEN** `inflexa setup` reaches its store step
- **THEN** it starts no process, and it reports the live run
