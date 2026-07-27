# Tasks — setup-answers-hardening

## 1. Fail-before-mutate ordering (design D1, D2)

- [x] 1.1 Reorder the batch direct path in `src/modules/infra/setup.ts`: run the answered model's 1-token validation (when validation is on) BEFORE `writeDirectConnection`, so a rejected id leaves `config.json` untouched; keep the persist step (write connection, then `writeBothAgents`) after a pass. Fix the comment at the cliproxy pin that claims it is the only post-mutation rejection, and scope the fail-before-mutate comment near the embedding pre-gate to batch.
- [x] 1.2 Add an orchestrator pre-mutation ref-id check immediately after `resolveSetupAnswers`: when `refs` is an id list, resolve it against the offered catalog and fail with both spellings plus each unknown id before the runtime gate; treat already-installed ids as valid (they resolve to nothing left to install). The download-time `unknown_dataset` check stays.
- [x] 1.3 Tests: a rejected batch direct model leaves `config.json` byte-identical to before the run (replace the assert-around at `setup.test.ts:1489`); an unknown ref id fails with no config write, container command, or download; a second run with a now-installed id list passes; the answered `--sandbox` pull still runs when refs succeed.

## 2. Single-sourced answer enumeration (design D3)

- [x] 2.1 Introduce the `ANSWER_QUESTIONS` table in `src/modules/infra/setup_answers.ts` (key → flag spelling + block/leaf location, including block-level keys `connection`/`postgres`/`resources`/`embedding`); derive `ANSWER_SPELLINGS` (or replace it) and make `mergeAnswers` iterate the table generically. Type-link the schema's leaf set to the table with a `satisfies` check so a schema-only addition is a compile error.
- [x] 2.2 Re-anchor the coverage guard (`declaredAnswerKeys` in `setup.test.ts`) on the single table, and verify `spellPath` renders both spellings for block-shaped errors (`postgres:` as a null block).
- [x] 2.3 Add a registry-level test that builds the real commander `setup` command, parses one argv exercising every Batch-mode option, and asserts each value lands in the resolved answers — pinning the `src/cli/index.ts` flag→answers literal.

## 3. Front-end parity (design D4, D6, D7)

- [x] 3.1 Extend the answers file's raw-text scan to reject non-plain-decimal unquoted numeric scalars at the numeric answer keys (`postgres.port`, `resources.sharePct`, `connection.auth.ttlMs`), naming both spellings — parity with the flag's `wholeNumber` rule; quoted scalars keep failing in the schema as type errors.
- [x] 3.2 Make `answersFromFlags` one-pass: drop uncandidatable values as today, still run `parseAnswers` on the surviving raw object, and report flag-level and schema-level problems together in one failure.
- [x] 3.3 Add a URL-shape refinement (`URL.canParse` + scheme required) to `connection.baseURL` and `embedding.baseURL` in the schema.
- [x] 3.4 Tests: file `port: 0x1F5B` and `sharePct: 1e2` rejected with both spellings; a malformed port plus an invalid enum reported in one failure; scheme-less `--base-url` fails upfront even with `--no-validate`; a mode-mismatched answer arriving FROM THE FILE through `loadSetupAnswers` errors (not only the pre-parsed-object path); `--config <a directory>` yields the unreadable-file error.

## 4. Mode-flag override semantics (design D5)

- [x] 4.1 In answer resolution, when a mode-carrying FLAG (`--connection`, `--embeddings`) moves a block's mode away from the FILE's, drop the file's leaves exclusive to the superseded mode from the merged answers and print a note naming each superseded key and the superseding flag. Same-source mismatches (flag-vs-flag, file-vs-file) keep failing upfront.
- [x] 4.2 Tests: `--config` (api-key embedding block) + `--embeddings off` succeeds, resolves to `off`, and prints the supersede note naming `embedding.baseURL`/`embedding.model`; `--connection cliproxy` over a direct-mode file likewise; `--embeddings off --embeddings-url …` (both flags) still fails; an all-file mismatch still fails.

## 5. Embedding hardening (design D9)

- [x] 5.1 Interactive api-key setup: when `INFLEXA_EMBEDDING_API_KEY` is exported, print a notice naming the variable before adopting it (mirroring the model-key note); the masked prompt still runs when it is unset.
- [x] 5.2 `--no-validate` assumed width: read `config.embedding.dimensions` only when the current mode is already `api-key`; otherwise use the provider default — never a local backend's measured width. State the assumption in the output.
- [x] 5.3 Widen the stranding warning trigger in `src/modules/embedding/setup.ts` to effective-width change: a different non-`off` mode, or a `local`→`local` switch to a different model path; an unchanged backend re-selection stays silent.
- [x] 5.4 Tests: env-adoption notice printed (interactive, var set) and masked prompt skipped; cross-mode `--no-validate` width falls back to the api-key default (machine configured with a 768 local GGUF); local→local GGUF swap warns, unchanged re-selection does not; a FAILING batch api-key endpoint probe exits non-zero with `embedding.mode` unchanged; an answered `--embeddings-gguf` pointing at an absent file fails naming the path.

## 6. Orchestration polish and test-gap closure

- [x] 6.1 Suppress the pre-staging sign-in notice when `options.auth === false` (`setup --yes --no-auth`), and drop interactive-worded banners (resource-allowance line) from batch output.
- [x] 6.2 Tests for the batch cliproxy model pin (`pinCliproxyModel`): a definite not-found fails the run naming the model; an inconclusive accessibility check proceeds and pins both agents; no test existed for either.
- [x] 6.3 Orchestration-level answered-interactive tests: `--postgres-password` on a TTY without `--yes` skips only the password prompt (user/port still prompted — the spec'd postgres scenario); `promptManualDirectConnection` skips exactly the answered questions; an answered direct fact suppresses the ecosystem-adoption ladder.
- [x] 6.4 Broaden the byte-identical idempotency test to a run with Postgres provisioning enabled (rebuilt postgres block, proxy config + minted key, resource budget all compared across the two runs).

## 7. Published env docs (design D8)

- [x] 7.1 Render `modelConnectionEnvDoc` and `embeddingEnvDoc` into `environment.md` in `scripts/gen_docs.ts`, sectioned as `--help` presents them.
- [x] 7.2 Add the unrendered-list guard: a test that fails when an exported `*EnvDoc` list in `src/lib/env.ts` reaches no rendered page, and pin that the generated page names `INFLEXA_MODEL_API_KEY` and `INFLEXA_EMBEDDING_API_KEY`.

## 8. Verification

- [x] 8.1 `bun run format:file` on every touched `src/` file; `bun run lint` and scoped `bun run typecheck` clean (pre-existing harness-link errors outside the PR's files excepted).
- [x] 8.2 Full scoped suites green: `bun test src/modules/infra/ src/modules/embedding/ src/modules/refs/ src/lib/env.test.ts src/cli/`; `bun scripts/gen_docs.ts` succeeds and the environment page carries both key variables.
