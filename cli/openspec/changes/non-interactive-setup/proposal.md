# Non-interactive setup (`--yes` batch mode + `--config` answers file)

## Why

Fleet provisioning needs `inflexa setup` to run unattended on clients that share one configuration. Today's headless branches are automation-hostile: they silently default (Postgres), silently skip (default model, resource allowance), or cannot receive a value at all (direct endpoint, embedding endpoint/key) — so an unattended run cannot state its intent, and a misconfiguration surfaces on the client's first chat instead of at provision time.

## What Changes

- **`--yes` becomes batch mode**: setup never prompts (**BREAKING**: today `--yes` only pre-consents reference downloads and the wizard still prompts on a TTY). Every interactive decision point gains a value flag; an unanswered question resolves to its default where one exists, else a hard error naming the missing flag/file key. Fail-before-mutate: the whole answer set is validated before anything touches disk.
- **`--config <file.yml>`**: a YAML answers file (parsed with the native `Bun.YAML` — no new dependency) covering the same decision points. Parsed strictly into our own answers schema — unknown keys are rejected, and `config.json` is always written by our own extraction of the keys we consume, never by copying file content verbatim.
- **One shared answers mechanism**: flags and the config file populate a single `SetupAnswers` shape with precedence `flag > config file > prompt (TTY, no --yes) > default-or-error (--yes)`. A supplied answer skips its prompt even in interactive mode, so a partially-filled file plus interactive prompts for the rest composes naturally.
- **New value flags** for: Postgres (user/password/port/database/host), direct connection (base-url/provider/protocol/model), credential source (auth-env/auth-command/auth-scheme/auth-format), resource share (percent), embeddings (url/model/gguf path; the api-key secret via an environment variable, never a flag), reference data (`--refs recommended|all|<id,…>`), sandbox image variant, runtime pin, and `--no-validate`.
- **`--provider` wears two vocabularies keyed on `--connection`**: cliproxy → OAuth account kind (interactive setup only — rejected under `--yes`, where cliproxy setup is pre-staging and auth happens at first launch via the existing gate); direct → open vendor slug.
- **Ecosystem-env adoption becomes interactive-only** (**BREAKING**: a scripted non-TTY `setup --connection direct` no longer self-configures from detected `ANTHROPIC_*`/`OPENAI_*` — batch requires explicit connection answers). Credential-helper detection likewise stays interactive.
- **No `--refs` means no reference downloads** (**BREAKING**: today a headless `--yes` run downloads the recommended set). Downloads happen only on an explicit `--refs` value; the value itself is the consent.
- **Validation probes default on** under `--yes` (the 1-token model ping, the embedding endpoint probe), and any outcome short of a pass fails the provision rather than the client's first chat — batch has no save-anyway confirm, so ambiguity fails hard; `--no-validate` opts out for air-gapped staging.
- **Reserved Postgres ports (8432/8434) are a hard error under `--yes`** instead of the wizard's warn-and-use-once — a value that would silently not persist must not pass in automation.

## Capabilities

### New Capabilities

- `setup-answers`: the shared answers mechanism — the `SetupAnswers` schema, its two front-ends (value flags, strict YAML file), the resolution precedence, the `--yes` no-prompt contract with its default-or-error table, upfront whole-set validation, and the batch error catalog.

### Modified Capabilities

- `model-connection`: the direct path becomes answerable — endpoint/provider/protocol/model via answers; the model id is REQUIRED under `--yes` (no silent skip into a `model_required` boot failure); ecosystem-env adoption and credential-helper detection are interactive-only affordances (batch requires explicit answers); the credential source is declarable via answers; model validation runs by default with `--no-validate` opt-out.
- `postgres-provisioning`: the credentials/port prompt becomes answerable; the persist-only-explicit contract is unchanged; a reserved-port answer is a hard error under `--yes`.
- `reference-data-provisioning`: setup's reference step takes `recommended|all|<ids>` presets as answers; absent `--refs` installs nothing under `--yes` (replaces the headless recommended-set default); an explicit selection needs no separate `--yes` consent — the value is the consent.
- `local-embeddings`: the api-key branch becomes answerable (endpoint/model via answers, key via environment variable); the custom-GGUF path gains an answer (lifting today's interactive-only restriction); mode switching under `--yes` still emits the index-stranding warning.
- `container-runtime`: an explicit runtime answer pins the runtime as a hard gate (no fallback switching); absent an answer, batch keeps detect-and-pin.

## Impact

- `src/modules/infra/setup.ts` — the orchestrator resolves `SetupAnswers` first, then drives the existing step functions with prompts replaced by answers (the existing deps-injection seams are the template).
- `src/cli/index.ts` — new flags on the `setup` registration, grouped under a batch heading via commander's `helpGroup`; every flag described (docs:gen requires it). Agent policy unchanged: `setup` stays `blocked`.
- New answers module in `src/modules/infra/` — the schema, the YAML front-end, precedence resolution, upfront validation.
- `src/modules/embedding/setup.ts` — api-key/custom-GGUF branches accept injected values.
- `src/modules/refs/commands.ts` — preset resolution (`recommended|all`) against the catalog; the no-`--refs`-means-none batch default.
- `src/lib/env.ts` — the embedding-key environment variable (secrets never ride flags).
- No new dependencies (`Bun.YAML` is native to the pinned Bun 1.3.14).
