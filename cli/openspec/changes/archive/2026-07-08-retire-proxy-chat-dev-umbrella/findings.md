# retire-proxy-chat-dev-umbrella — Findings

## F1 — Gate verified end-to-end at the source runtime; binary-level proof blocked by a PRE-EXISTING build break

The channel gate's full truth table was verified against the source runtime (the identical
`devCommandsEnabled()` code path — compilation only changes where the channel value comes from):

1. dev (no env) → `chat`/`profile`/`run` PRESENT;
2. `INFLEXA_BUILD_CHANNEL=release` → the three ABSENT; the remaining surface is exactly the
   dev-commands spec's release list;
3. release + `inflexa chat` → hard non-zero refusal (commander rejects the unregistered name as
   "too many arguments" because the root default action takes no positionals — a refusal message,
   not the literal "unknown command"; spec wording aligned at sync);
4. release + `INFLEXA_DEV=1` → PRESENT (the escape hatch).

**The release binary itself cannot currently be built at HEAD** — `bun run build` fails during
bundling on unresolvable lazy requires inside `@dbos-inc/dbos-sdk`'s telemetry
(`winston`, `winston-transport`, `@opentelemetry/exporter-logs-otlp-proto` — none present in the
dependency tree). Reproduced IDENTICALLY on the unmodified HEAD tree (stash → build → pop), so it
is pre-existing and unrelated to this change. Filed on the tracker as its own follow-up: release
builds are broken until the DBOS telemetry externals are handled (externalize/stub at build time,
or dependency additions).

## F2 — The retirement was a pure subtraction

The engine's only importer was the boot-helpers line; the six session-scoped bus members had zero
consumers. After the moves (`readApiKey`/`resolveModelId`/`pickDefaultModel`/`ChatSetupError` →
`modules/proxy/models.ts`; `sessions.ts` → `modules/analysis/`), `modules/intelligence/` is gone
and typecheck/lint/tests prove nothing dangled: **576 tests, 0 fail**.

## F3 — Orphans deliberately left (future db cleanup)

`updateMessage`/`updatePart` in `db/primary_mutation.ts` lost their last non-test consumer with the
engine. Left in place alongside the read queries over the frozen `messages`/`parts` tables (the
design's freeze decision); flagged for a future primary-store cleanup change rather than scope
creep here.
