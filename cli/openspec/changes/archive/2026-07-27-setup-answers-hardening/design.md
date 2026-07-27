# Design — setup answers hardening

## Context

PR #237's review confirmed that the non-interactive setup shipped with two fail-before-mutate violations (the answered direct model is pinged *after* `writeDirectConnection`; unknown ref ids surface at download time, second-to-last step), several front-end parity gaps (YAML numeric literals, URL shape, one-pass reporting, mode-flag overrides), a structural drift hole (the answer set is hand-enumerated in four places — zod schema, `ANSWER_SPELLINGS`, `mergeAnswers`, and the `index.ts` flag mapping — with the coverage guard anchored to only one of them), a published-docs gap (`environment.md` renders `envDoc` only, omitting `INFLEXA_EMBEDDING_API_KEY`/`INFLEXA_MODEL_API_KEY`), and a set of polish items. Everything sits on this branch, unreleased, so fixes are contract corrections rather than breaking changes.

## Goals / Non-Goals

**Goals:**

- Restore the two fail-before-mutate guarantees the specs already state (model probe before connection write; ref-id validation before any mutation).
- Make the answer-set enumeration single-sourced so an answer cannot ship parsed-but-dropped or unspelled.
- Align the three resolution legs (flag / file / prompt) on one validity rule per question: numeric literal shape, URL shape.
- Honor "a flag overrides the file's answer" for mode-carrying flags without violating "no answer is ever silently ignored".
- Render every env-var doc list into the published reference.
- Land the review's polish items and close the test gaps it named.

**Non-Goals:**

- No new flags, no new answers, no answers-file format change (beyond stricter numeric-literal rejection).
- No change to interactive wizard flows beyond the specified notices/warnings.
- No `--dry-run`/`--emit-config` (still deferred from the original change).

## Decisions

### D1 — Validate the answered direct model before writing the connection

`persistAnsweredDirectModel`'s probe needs only `direct.baseURL`, the protocol, and a credential (the probe token or `resolveModelApiKey`) — all in hand before `writeDirectConnection`. Reorder the batch direct path to: resolve credential → validate model (when answered and validation is on) → write connection → persist model. The comment at the cliproxy pin claiming it is "the ONE answer whose rejection lands after mutation" becomes true again. *Alternative rejected:* roll back the connection write on probe failure — remediation where prevention is available, and a crash between write and rollback still strands the config.

### D2 — Ref ids validate in the orchestrator, immediately after answer resolution

The resolver's "this layer never loads the catalog" stance is worth keeping (it stays a pure function of its inputs). Instead the orchestrator runs a pre-mutation validation step directly after `resolveSetupAnswers`, before the runtime gate: when `refs` is an id list, resolve it against the offered catalog (`offeredReferenceCatalog`) and fail with both spellings and the unknown ids before anything mutates. The download-time `unknown_dataset` check remains as defense in depth. Already-installed ids are not unknown (the offered set excludes installed — the check must treat installed ids as valid answers that resolve to nothing to do, matching idempotency). *Alternative rejected:* loading the catalog inside `resolveSetupAnswers` — couples the answers module to the refs store and makes resolution I/O-dependent for every caller.

### D3 — One answer-question table; everything else derives or is guard-linked

Introduce a single `ANSWER_QUESTIONS` declaration in `setup_answers.ts` keyed by `AnswerKey`, carrying each question's flag spelling and block/leaf location. From it: `ANSWER_SPELLINGS` is derived (or replaced), `mergeAnswers` iterates it generically (per-leaf flag-over-file), and block-level keys (`connection`, `postgres`, `resources`, `embedding`) get spellings so `spellPath` renders both spellings for block-shaped errors. The schema stays zod, but a type-level check (`satisfies` over the schema's leaf paths) makes a schema leaf without a table entry a compile error, and the existing source-scrape guard re-anchors on the table. For the CLI surface, add a registry-level test that builds the real commander program, parses one argv exercising every Batch-mode option, and asserts each lands in the resolved answers — pinning the `index.ts` mapping literal. *Alternative rejected:* generating flags from the table at registration time — commander declarations also carry help text, parsers, and grouping, and `index.ts` must stay a thin, readable registry (docs:gen walks it).

### D4 — Numeric parity via the raw-text scan the module already has

`Bun.YAML.parse` resolves `0x1F5B`/`1e2` before zod can see the literal, so parity cannot live in the schema. Extend the existing raw-text scan (precedent: the duplicate-key scan) to reject non-plain-decimal unquoted scalars at the numeric answer keys (`postgres.port`, `resources.sharePct`, `connection.auth.ttlMs`), naming both spellings — the flag's `wholeNumber` rationale ("a value the CLI cannot echo back unchanged is a value the author cannot verify") applies to the file verbatim. Quoted scalars are strings and already fail the schema's number check. *Alternative rejected:* relaxing the flag to YAML-core semantics — it would make `--postgres-port 0x1F5B` legal, which no fleet author wants to debug.

### D5 — A mode-carrying flag supersedes the file's dependent leaves, loudly

When a flag answers a block's mode (`--embeddings`, `--connection`), file-sourced leaves of that block that are exclusive to a *different* mode are dropped from the merged answers, and the run prints a note naming exactly what was superseded and by which flag ("`--embeddings off` supersedes `embedding.baseURL`, `embedding.model` from fleet.yml"). This honors "a flag overrides the file's answer for that question" while keeping "no answer is silently ignored" — the drop is announced, not silent. Mismatches within one source (a flag mode against flag leaves, or a file mode against file leaves) still fail as they do today: same-source contradictions are authoring errors, not overrides. *Alternative rejected:* keeping the hard failure — it makes the documented per-machine override (`--config fleet.yml --embeddings off`) impossible.

### D6 — One-pass reporting concatenates flag-level and schema-level problems

`answersFromFlags` stops early-returning on flag-level problems: it drops the uncandidatable values (as today), runs `parseAnswers` on the surviving raw object, and reports both problem lists in one failure. A dropped candidate cannot double-report — it is absent from the raw object the schema sees.

### D7 — URL shape lives in the schema

`connection.baseURL` and `embedding.baseURL` gain a zod refinement (`URL.canParse`, scheme required) so the flag and file legs enforce what the interactive prompts already do. The error names both spellings like every schema error.

### D8 — The environment page renders every declared env-doc list

`gen_docs.ts` renders `environment.md` from `envDoc`, `modelConnectionEnvDoc`, and `embeddingEnvDoc` (sectioned like `--help` presents them). A test pins that the rendered page names `INFLEXA_MODEL_API_KEY` and `INFLEXA_EMBEDDING_API_KEY`, so a future doc list added to `lib/env.ts` without a render site fails visibly rather than vanishing from the website.

### D9 — Polish, each behind its existing seam

- `--no-auth` under batch: the pre-staging sign-in notice is gated on `options.auth !== false` (the operator disabled the step; guidance for it is noise).
- Interactive api-key embeddings with `INFLEXA_EMBEDDING_API_KEY` exported: print "Using INFLEXA_EMBEDDING_API_KEY from your environment" (mirroring the model-key note) instead of silently skipping the masked prompt.
- `--no-validate` assumed width: the fallback reads the configured width only when the *current mode is already api-key*; otherwise the provider default — a local GGUF's measured width is never adopted for an api-key backend.
- Stranding warning: trigger on effective-width change — a different mode, or local→local where the target GGUF's measured/known width differs from the configured one. When the width is unknowable pre-verification (custom GGUF), warn on the mode/model-path change conservatively.
- Batch runs drop interactive-worded banners ("Configure the analysis resource allowance…").
- Comment fix at the cliproxy pin (see D1) and at the interactive fail-before-mutate claim near the embedding pre-gate (scope it to batch).

## Risks / Trade-offs

- [D2 treats installed ids as valid] → pinned by an idempotency-flavored test: a second run with the same id list must not fail on now-installed ids.
- [D4 raw-text scan false positives] → scoped to the numeric answer keys only, unquoted scalars only; quoted strings keep failing in the schema with a type error naming both spellings.
- [D5 changes an error into an override] → unreleased behavior; the supersede note keeps the fleet file auditable. Same-source mismatches still fail, so genuine authoring errors are not masked.
- [D3 touches the module's core tables] → the change is mechanical and the 98 existing answers tests plus the re-anchored guard must stay green; any behavior change beyond block-spelling errors is a defect.
- [Stranding-warning widening may over-warn] → acceptable: a false warning costs a sentence; a missed one costs stranded indexes.

## Migration Plan

Single branch-local change; no data migration, no persisted-format change. All fixes land before the feature ships, so no release note beyond the original change's notes is needed.

## Open Questions

None blocking.
