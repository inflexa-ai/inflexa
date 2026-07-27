# setup-answers Specification (delta)

## ADDED Requirements

### Requirement: One answers mechanism resolves every setup question

Setup SHALL define a single answers schema (`SetupAnswers`) covering every interactive decision point of the setup flow — connection mode, direct-connection facts, credential source, model, Postgres fields, resource share, embedding backend and its values, reference selection, sandbox variant, and runtime. Two front-ends populate it: value flags and the `--config` YAML file, resolved per question with the fixed precedence:

```
flag  >  config-file value  >  interactive prompt (TTY and not --yes)  >  default-or-error (--yes or non-TTY)
```

A supplied answer SHALL skip its prompt even in an interactive run, so a partially-filled config file composes with prompts for the remaining questions. A non-TTY run SHALL resolve exactly as `--yes` does. Every persisted value SHALL flow through the same writers the interactive wizard uses — the answers layer changes where values come from, never where they go.

#### Scenario: A flag overrides the config file

- **WHEN** setup runs with `--config fleet.yml` (carrying `postgres.password: a`) and `--postgres-password b`
- **THEN** the resolved answer for the Postgres password is `b`

#### Scenario: A config file answers questions interactively; prompts fill the gaps

- **WHEN** setup runs on a TTY without `--yes`, with a config file answering the connection and Postgres questions but not embeddings
- **THEN** the connection and Postgres prompts are skipped, and the embedding question is still asked

#### Scenario: Non-TTY resolves like --yes

- **WHEN** setup runs without a TTY and without `--yes`
- **THEN** no prompt is attempted and every question resolves through the same default-or-error path `--yes` uses

### Requirement: `--yes` never prompts and validates the whole answer set before mutating

Under `--yes`, setup SHALL never prompt — on a TTY or off it. The complete answer set SHALL be validated BEFORE any mutation (config writes, container work, downloads): flag parse errors, config-file schema violations, unknown reference ids, reserved Postgres ports, contextually-required-but-absent answers, and mode-mismatched answers the resolved modes cannot consume (a direct-only `--base-url` under cliproxy, an `--embeddings-gguf` with api-key embeddings — no answer is ever silently ignored) all fail here, and each error SHALL name both spellings of the answer (the flag and the file key). Unanswered questions resolve to their defaults: connection `cliproxy`; Postgres per-field defaults (persisting nothing); resource allowance the resolved default (unpersisted); embedding mode unchanged; reference downloads none; sandbox image skipped; model unanswered means Auto in cliproxy mode and an upfront error in direct mode.

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

Under batch resolution in cliproxy mode, setup SHALL provision everything except the provider login: proxy config, compose file, images, Postgres, and the answered optional steps. When no provider credential exists in the auth dir, setup SHALL print a notice that the first launch will offer the interactive sign-in and SHALL exit 0 — pre-staging is a legitimate outcome, not a failure.

#### Scenario: Pre-staging without a credential succeeds with a notice

- **WHEN** `inflexa setup --yes` completes on a machine whose proxy auth dir holds no credential
- **THEN** the stack is provisioned, a notice names the first-launch sign-in, and the exit code is 0

### Requirement: Validation probes default on; `--no-validate` opts out of network probes

Under batch resolution, the same validations the wizard performs SHALL run by default: the credential-source probe ladder when `auth` is answered, the protocol-shaped 1-token message validation for a direct model answer, and the one-embed endpoint probe for api-key embeddings. Any probe outcome short of a pass — a definite rejection, an unreachable endpoint, or an answer the probe cannot classify — SHALL fail the provision with the endpoint's response shown: batch has no save-anyway confirm, so ambiguity fails hard and `--no-validate` is the sole escape. `--no-validate` SHALL skip the NETWORK probes only — local GGUF verification through the sidecar is offline and SHALL always run. With network probes skipped: a direct model answer persists unvalidated (boot and first chat remain the gate), and api-key embedding dimensions fall back to the configured or provider-default width instead of a measured one, stated in the step's output.

#### Scenario: A bad direct model fails the provision

- **WHEN** `setup --yes --connection direct` runs with validation on and the endpoint answers the model validation with a definite model-not-found
- **THEN** setup exits non-zero showing the endpoint's rejection, and the model is not persisted

#### Scenario: --no-validate persists unvalidated

- **WHEN** the same run adds `--no-validate`
- **THEN** the model persists without any validation request, and the run's output states the pick is unvalidated

#### Scenario: Local GGUF verification is never skipped

- **WHEN** `setup --yes --embeddings local --no-validate` runs
- **THEN** the sidecar verification probe of the model still runs (it is offline), and only network probes were skipped

### Requirement: Secrets never ride answers

No answer — flag or file key — SHALL carry a secret. The direct-connection model key remains an environment read (`INFLEXA_MODEL_API_KEY`, then the provider-conventional variable). The api-key embedding secret SHALL be read from the `INFLEXA_EMBEDDING_API_KEY` environment variable via the sole `process.env` reader, and is REQUIRED (as an env var) when the answers select api-key embeddings under batch resolution; it is persisted to `config.json` exactly as the wizard's masked prompt persists it. Credential-source answers (`auth.*`) are token-free by construction — a variable name, a command string, a scheme — mirroring what `config.json` already stores.

#### Scenario: Batch api-key embeddings without the env var fails upfront

- **WHEN** `setup --yes --embeddings api-key --embeddings-url https://api.openai.com/v1` runs with `INFLEXA_EMBEDDING_API_KEY` unset
- **THEN** setup fails during upfront validation naming the variable, before any provisioning

### Requirement: The sandbox image and resource allowance are answerable

`--sandbox python|python-r` (file: `sandbox`) SHALL answer the sandbox-image variant; the answer IS the multi-GB consent, and the pull runs without a size confirmation. Absent an answer, batch setup SHALL skip the image (with the existing pull-later hint) — it is never downloaded implicitly. `resources.sharePct` (flag `--resource-share <pct>`, 1–100) SHALL answer the machine-allowance question as a percentage — portable across heterogeneous fleets — persisted as the absolute budget computed from the detected machine, exactly as the wizard's prompt persists it.

#### Scenario: A sandbox answer pulls without confirmation

- **WHEN** `setup --yes --sandbox python` runs with the image absent locally
- **THEN** the image is pulled with no size prompt and recorded as `harness.sandboxImage`

#### Scenario: No sandbox answer downloads nothing

- **WHEN** `setup --yes` runs without `--sandbox`
- **THEN** no image is pulled and the pull-later hint is printed

#### Scenario: The resource share persists machine-relative absolutes

- **WHEN** `setup --yes --resource-share 50` runs on an 8-core / 32 GB machine
- **THEN** `harness.resourceLimits.budget` persists 4 CPU / 16 GB

### Requirement: Batch setup is idempotent

Re-running batch setup with the same answers SHALL converge to the same final state without destructive or duplicate work: an existing proxy config is left untouched, the compose file is regenerated, images and datasets already present are not re-fetched, the vector extension install is a no-op, and persist-only-explicit config writes rebuild to the same content.

#### Scenario: A second identical run changes nothing

- **WHEN** `setup --yes --config fleet.yml` runs twice on the same machine
- **THEN** the second run completes successfully with no re-downloads and a byte-identical resulting configuration
