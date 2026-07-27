# Design — non-interactive setup

## Context

`inflexa setup` is an interactive wizard whose every step already has a headless branch, but those branches were designed as graceful degradation, not automation: Postgres silently defaults, the default-model and resource steps silently skip, and the direct-connection and api-key-embedding steps have no way to receive a value at all (their values only exist as prompts). Fleet provisioning — N client machines sharing one configuration — needs the same flow to run unattended with explicit values, strict upfront failure, and reproducible outcomes.

Two structural facts shape the design:

1. **One step is interactive by nature, not by implementation**: cliproxy provider OAuth needs a human in a browser, and a credential cannot be pre-seeded across a fleet (two proxies refreshing one rotating refresh token corrupt it — the collision documented at `lib/env.ts` `stackPaths`). Batch cliproxy setup is therefore *pre-staging*: everything except the login, which each client performs once at first launch via the existing launch-gate offer.
2. **The step handlers are already headless-capable and seam-injected** (`selectDefaultModel`'s deps, `collectDirectModel`'s deps, `runEmbeddingSetup(interactive, preselected)`, `runReferenceSetup({interactive, ids, yes})`, `sandboxPull({variant, yes})`). The missing piece is not new steps but a uniform way to *answer* their questions without a TTY.

## Goals / Non-Goals

**Goals:**

- `inflexa setup --yes`: never prompts, accepts a value for every interactive decision, validates the whole answer set before mutating anything, and fails with errors that name the missing/invalid flag and file key.
- `inflexa setup --config <file.yml>`: the same answers from a strict YAML file; flags override file values.
- One mechanism: a `SetupAnswers` schema that both front-ends populate; interactive prompts become the fallback source for unanswered questions.
- Idempotency as a documented contract: re-running with the same answers converges (the existing machinery — config-exists-untouched, compose regeneration, pull-if-missing, `CREATE EXTENSION IF NOT EXISTS`, persist-only-explicit — already carries this).

**Non-Goals:**

- No new command (the `bootstrap`/`provision` alternative was considered and rejected — see D1).
- No unattended cliproxy OAuth, and no credential pre-seeding.
- No per-agent model answers (`models.agents.*` divergence stays a palette power feature; setup's `--model` pins both agents, as the wizard's explicit pick does).
- No emission/round-tripping of the answers file (setup consumes it; it never writes one).
- No telemetry/theme answers (not setup questions today).

## Decisions

### D1 — Batch mode is `setup --yes`, not a new command

`--yes` already exists on `setup` as download consent, and today's non-TTY setup already *is* a degraded batch mode. Promoting `--yes` to "never prompt; answers unlock" evolves an existing contract instead of teaching a new command name, and keeps the one dogfooded orchestrator. The separate-command alternative (`bootstrap`) was rejected once its two advantages dissolved: help clutter is solved by commander ^15 `helpGroup` (verified in the vendored typings), and the `--provider` vocabulary collision is resolved by keying on `--connection` (D4). **Consequence accepted**: `--yes` on a TTY changes meaning (see Risks).

### D2 — The answers model: one schema, three sources, fixed precedence

Every interactive decision point becomes a named question in a single zod `SetupAnswers` schema (all fields optional at parse time — requiredness is contextual, enforced by the resolver). Resolution per question:

```
flag  >  --config file value  >  prompt (TTY and not --yes)  >  default-or-error (--yes or non-TTY)
```

- A supplied answer **skips its prompt even in interactive mode** (preseed semantics). This generalizes what `--embeddings`/`--refs`/`--provider` already do and makes `--config org.yml` without `--yes` a guided-onboarding mode: the file answers most questions, the human answers the rest.
- `--config` and `--yes` are orthogonal: file = answer source, `--yes` = no-prompt guarantee. Fleet automation passes both.
- The resolver runs **before any mutation**: flag parse errors, file schema violations, catalog-unknown ref ids, reserved ports, contextually-missing answers (direct mode without `baseURL`/`provider`/`model` under `--yes`), and mode-mismatched answers the resolved connection cannot consume (a direct-only `--base-url` under cliproxy — no answer is ever silently ignored) all fail here, naming both spellings of the answer (`--base-url` / `connection.baseURL`).

Alternative considered: per-step flag threading (today's `--embeddings` pattern repeated ×15). Rejected: each flag would re-implement its own TTY/preselect/error logic; the answers layer centralizes it once.

### D3 — The file carries configuration answers; execution modifiers stay flag-only

The YAML file describes *the desired client configuration* — connection, postgres, resources, embedding, refs, sandbox, runtime. Invocation behavior — `--yes`, `--no-start`, `--no-postgres`, `--force`, `--no-validate`, `--no-auth` — stays flag-only: those answer "how should THIS run behave", not "what should this client look like", and a fleet file that baked `start: false` would surprise every future invocation. This line keeps the file portable across invocations and the flag surface honest.

File shape (camelCase keys, matching the config.json idiom):

```yaml
connection:
  mode: direct                # cliproxy | direct
  provider: anthropic         # direct: open vendor slug; cliproxy: OAuth account kind (interactive runs only)
  baseURL: https://api.anthropic.com/v1
  protocol: anthropic         # optional; inferred from provider when absent
  model: claude-sonnet-5      # REQUIRED under --yes when mode is direct
  auth:                       # optional refreshing credential source (token-free, as in config.json)
    kind: command             # env | command
    command: my-token-helper
    scheme: bearer            # x-api-key | bearer
    format: raw               # raw | exec-credential (command kind only)
    ttlMs: 300000             # optional (command kind only)
postgres:
  user: inflexa
  password: inflexa
  port: 5555
  database: inflexa
  host: localhost
resources:
  sharePct: 50                # percent of the detected machine — portable across heterogeneous fleets
embedding:                    # singular — matches config.json's block name
  mode: api-key               # local | api-key | off
  baseURL: https://api.openai.com/v1   # api-key mode
  model: text-embedding-3-small        # api-key mode
  gguf: /path/to/model.gguf            # local mode with a user-owned GGUF
refs: recommended             # recommended | all | [CollecTRI, msigdb-hallmark]
sandbox: python               # python | python-r
runtime: docker               # docker | podman
```

### D4 — `--provider` keys its vocabulary on `--connection`

cliproxy → OAuth account kind (`gemini|openai|claude|qwen|iflow`), the existing meaning, valid only where OAuth can run (interactive). direct → open vendor slug (`anthropic`, `openai`, `google`, …), the `models.connection.provider` fact. Under `--yes` with cliproxy, `--provider` (and `connection.provider` in the file) is **rejected** with an error explaining that OAuth cannot run unattended and pointing at the first-launch login. The two enums are disjoint in meaning but overlap in spelling (`openai`, `qwen`, `iflow`), so context-keying — not merging — is what keeps each mode's validation exact.

### D5 — Refs: the value is the consent; absence is none

`--refs recommended|all|<id,…>` (file: string preset or id list). `recommended` resolves against the catalog's `recommendation.recommended` datasets; `all` against the whole offered catalog; both resolve against the *offered* set (already-installed datasets are excluded, exactly as `offeredReferenceCatalog` does). Absent `--refs` under `--yes` installs **nothing** — this deliberately replaces the headless recommended-set-with-`--yes` default: in the new model `--yes` is a mode, not a consent, so a download must be named to happen. The preset words are validated to not collide with catalog ids at resolve time (a collision is a catalog-authoring error surfaced loudly, not shadowed). The `recommended-set` spelling was considered and shortened: one word, same meaning.

### D6 — The file is strict; config.json is written by extraction

Unknown YAML keys are **errors** naming the offending key — the opposite of `config.json`'s lenient per-field `.catch` philosophy, and deliberately so: config.json is runtime state that must survive corruption; the answers file is authored intent at provision time, where a typo'd `embedings:` silently skipping a step is the worst failure a fleet can have. Nothing from the file is ever merged verbatim into `config.json`: the resolver extracts the keys it consumes into `SetupAnswers`, and every persisted value flows through the same writers the wizard uses (`writeConfig`, `writeDirectConnection`, `writeAgentModel`, `explicitPostgresFields`). No version field in v1 — a fleet authors its file against its CLI version, and the strict-key error message is the drift detector.

### D7 — Secrets never ride flags or the file

- Model key: unchanged — `INFLEXA_MODEL_API_KEY`, falling back to the provider-conventional variable (`resolveModelApiKey`). Never persisted.
- Embedding api-key: a new environment variable `INFLEXA_EMBEDDING_API_KEY`, read via `lib/env.ts` (the sole `process.env` reader) at setup time and persisted to `config.json` exactly as the wizard's masked prompt persists it today. Required (as an env var) when the answers select api-key embeddings under `--yes`.
- Credential-source answers (`auth.*`) are token-free by construction — command strings, variable names, schemes — so they may ride flags and the file, mirroring what `config.json` already stores.
- Postgres password rides flags/file: it is already stored cleartext in `config.json` for a loopback-only container with well-known defaults; the file front-end is the recommended spelling for anyone who minds argv visibility.

### D8 — Validation probes default on; `--no-validate` opts out

Under `--yes`, the same probes the wizard runs stay on: the credential-source probe ladder when `auth` is answered, the 1-token model ping for a direct `--model`, the one-embed endpoint probe for api-key embeddings, and local-GGUF verification (offline — never skipped). Any probe outcome short of a pass — a definite rejection, an unreachable endpoint, or an answer the probe cannot classify — fails the provision with the endpoint's response shown: batch has no save-anyway confirm, so ambiguity fails hard, and `--no-validate` is the deliberate escape for gateways that cannot pass a standards-shaped probe (automation wants the failure at provision time, not first chat). `--no-validate` skips the *network* probes for air-gapped staging; consequences: the direct model persists unvalidated (boot/first chat remain the gate, today's non-TTY contract), and api-key embedding dimensions fall back to the configured/default width instead of the measured one — surfaced in the step's output. Under `--yes` + cliproxy + `--model`, the pin is checked via the unbilled `count_tokens` accessibility route when the proxy answers; only a definite `not_found` fails, `inconclusive` proceeds (the election's own philosophy) — the accessibility check is opportunistic, and a pre-staged proxy has no credential loaded, so an inconclusive check must not fail a legitimate pre-stage; the strict pass-or-fail contract above applies to the probes that validate user-supplied endpoint facts.

### D9 — Runtime answer is a hard gate; absence keeps detect-and-pin

`--runtime docker|podman` (file: `runtime`) pins the runtime with `ensureRuntime`'s hard-gate semantics — given-but-dead is an error, never a silent fallback (a fleet must not end up heterogeneous because Docker happened to be stopped on one client). Absent an answer, batch keeps setup's existing detect-preference-then-pin behavior, which is already deterministic and persisted.

### D10 — Batch cliproxy is pre-staging

Under `--yes` with cliproxy: provision proxy config, compose, images, Postgres, embeddings, refs, sandbox — and if no provider credential exists (`hasProviderCredential`), print a notice that first launch will offer the sign-in, and exit 0. Automation that wants to assert a credential exists can grep the notice; an error exit here would make the (legitimate) pre-staging workflow impossible to script.

### D11 — Reserved Postgres ports are a hard error under `--yes`

The wizard warns and uses a reserved port (8432/8434) for the current run without persisting it — acceptable interactively, poison in automation where "the value you passed was silently not persisted" is invisible. Under `--yes` the resolver rejects it upfront, naming the channel-default collision and the reserved set. Interactive behavior is unchanged.

### D12 — Placement

The answers schema + resolver live in a new `src/modules/infra/setup_answers.ts` (the setup feature slice owns its contract, mirroring how `modules/harness/config.ts` owns the `harness` block). `src/cli/index.ts` stays a thin registry: it declares the flags (grouped under a "Batch mode" `helpGroup` heading, every option described for docs:gen) and passes raw values through; parsing, file reading (`Bun.YAML.parse`, boundary-wrapped into a `Result`), merging, and validation happen in the module. The orchestrator in `setup.ts` consumes only the resolved `SetupAnswers`.

## Risks / Trade-offs

- **[`--yes` semantic break]** Scripts using today's `setup --yes` on a TTY get a non-interactive run; headless `--yes` without `--refs` stops downloading the recommended set; and a scripted non-TTY direct setup no longer adopts the detected provider environment. → All three are deliberate and documented (proposal marks them BREAKING); the new behavior is strictly more predictable, and the refs change only ever *reduces* surprise downloads. The release notes name the migrations (`--refs recommended` restores the old refs outcome; explicit `--base-url`/`--provider` answers replace adoption).
- **[Flag/file schema drift]** Two front-ends for one schema could diverge. → They cannot: flags map into the same zod schema the file parses into; there is exactly one source of key names and validation.
- **[Strict file vs CLI version skew]** A newer file key on an older CLI errors. → Accepted: that error is the *point* (silent ignoring is worse); the message names the key so the mismatch is diagnosable in one line.
- **[Prompt-skipping changes the wizard]** Passing a value flag interactively now skips that prompt. → Consistent with what `--embeddings`/`--provider`/`--refs` already do; the wizard's no-flag experience is untouched.
- **[Unvalidated provisioning under `--no-validate`]** A client can be staged with a broken endpoint/model. → Explicit opt-out; failures surface at the existing actionable gates (boot `model_required`/auth banner, embedder readiness gate).
- **[argv-visible postgres password]** → Documented; the file spelling avoids it; the secret is loopback-only and already cleartext in config.json.

## Migration Plan

No data migration. Ship in one release with the three BREAKING notes in the changelog. Rollback is uninstalling the flags — no persisted format changes (the answers file is an input, config.json writes go through existing writers).

## Open Questions

None blocking. (Deferred, non-blocking: an `inflexa setup --emit-config` that prints the current machine's answers as YAML — a natural v2 for cloning an existing golden machine; and `--dry-run` printing the resolved plan, which the fail-before-mutate resolver makes nearly free.)
