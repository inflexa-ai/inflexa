# Setup answers hardening (post-review fixes for non-interactive setup)

## Why

The PR #237 review confirmed eight defects and a set of polish gaps in the just-landed non-interactive setup: two places where the implementation violates the fail-before-mutate contract its own specs state (a rejected direct model strands a written connection; a typo'd ref id half-provisions a machine), several places where the two answer front-ends or the three resolution legs disagree (numeric literals, URL shape, mode overrides, one-pass reporting), a structural drift hole in the hand-enumerated answer set, and a published-docs gap that hides the only channel the embedding secret travels on. All of it is cheapest to fix now, on the same branch, before the batch contract ships.

## What Changes

- **Validate the answered direct model before writing the connection**: under batch direct mode, the 1-token model ping runs before `writeDirectConnection`, so a rejected model id leaves `config.json` untouched instead of stranding a connection-without-model that boots into `model_required`.
- **Validate reference ids upfront**: the answers resolver checks `--refs` ids against the offered catalog before any mutation, as `setup-answers` already requires; a typo'd id fails the run before the runtime pin, proxy config, containers, or downloads happen. The download-time `unknown_dataset` check remains as defense in depth.
- **Single-source the answer-set enumeration**: the schema, `ANSWER_SPELLINGS`, `mergeAnswers`, and the CLI flag→answers mapping are linked so an answer added in one place cannot ship silently dropped or unspelled; the coverage guard anchors on the linked source. Block-level file errors (`postgres:` as a null block) name both spellings like leaf errors do.
- **File/flag numeric parity**: the answers file rejects the same non-plain-decimal integer literals (`0x1F5B`, `1e2`) the flags reject, restoring the one-set-of-validations claim.
- **Mode-flag override semantics**: a mode-carrying flag (`--embeddings off`, `--connection cliproxy`) supersedes the config file's dependent leaves within its block instead of hard-failing against the file's now-moot values, honoring the "a flag overrides the file's answer" contract.
- **URL shape validation in the schema**: `connection.baseURL` and `embedding.baseURL` require a parseable URL with a scheme at resolution time, matching what the interactive prompts already enforce.
- **One-pass flag problem reporting**: `answersFromFlags` collects flag-level and schema-level problems in the same pass instead of suppressing the latter behind the former.
- **Env docs completeness**: the published `environment.md` renders every env-var doc list (`envDoc`, `modelConnectionEnvDoc`, `embeddingEnvDoc`), so `INFLEXA_EMBEDDING_API_KEY` / `INFLEXA_MODEL_API_KEY` appear in the CLI reference.
- **Polish**: `setup --yes --no-auth` suppresses the sign-in pre-staging notice; interactive api-key embedding setup prints a notice when it adopts `INFLEXA_EMBEDDING_API_KEY` from the environment (mirroring the model-key path); the `--no-validate` assumed embedding width never inherits another backend's measured width; the index-stranding warning keys on effective width change (covering local→local GGUF swaps), and batch runs drop interactive-worded step banners.
- **Spec-wording amendments**: the `setup-answers` secret rule is narrowed to the rule actually implemented (model and embedding secrets are env-only; `postgres.password` is an answer with a documented argv-visibility trade-off), removing the internal contradiction.

None of these are breaking against `main` — every touched behavior was introduced on this branch and is unreleased.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `setup-answers`: upfront unknown-ref-id validation gains a pinning scenario; front-end parity extends to numeric literal shape and URL shape; both-spellings extends to block-level errors; one-pass reporting becomes a stated requirement; mode-carrying flag override semantics over a file's dependent leaves; the no-secrets rule is amended to the implemented rule.
- `model-connection`: the batch direct path validates the answered model before any connection write; `--yes --no-auth` suppresses the pre-staging sign-in notice.
- `local-embeddings`: the env-adopted api-key secret is announced interactively; the `--no-validate` assumed width is mode-appropriate, never another backend's measured width; the stranding warning triggers on effective width change, not only mode change.
- `cli-reference-docs`: the environment page requirement covers all env-var doc lists, not only `envDoc`.

## Impact

- `cli/src/modules/infra/setup_answers.ts` — schema (URL shape, numeric parity, ref-id check), enumeration single-sourcing, `answersFromFlags` one-pass, merge semantics for mode-carrying flags.
- `cli/src/modules/infra/setup.ts` — direct-model validate-before-write ordering; `--no-auth` notice gate; batch wording.
- `cli/src/modules/embedding/setup.ts` — env-adoption notice, assumed-width source, stranding-warning trigger.
- `cli/src/cli/index.ts` + `cli/src/lib/env.ts` + `cli/scripts/gen_docs.ts` — flag mapping single-sourcing hooks; env doc lists rendered into `environment.md`.
- Tests: new coverage for every changed behavior, including the paths the review flagged as unexercised (batch cliproxy model pin, answered-interactive orchestration, failing api-key embedding probe, file-side mode mismatch through `loadSetupAnswers`).
- Spec deltas for the four modified capabilities; no new dependencies.
