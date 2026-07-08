# retire-proxy-chat-dev-umbrella — Tasks

## 1. Engine retirement + relocations

- [x] 1.1 Move `readApiKey`/`resolveModelId`/`pickDefaultModel`/`ChatSetupError` from
      `modules/intelligence/chat.ts` to `modules/proxy/models.ts` (move, no shims; JSDoc intact);
      retarget `modules/harness/runtime.ts` and any other importer; carry over their tests from
      `chat.test.ts` (D3).
- [x] 1.2 Move `sessions.ts` to `modules/analysis/sessions.ts` (behavior unchanged; JSDoc notes the
      frozen messages/parts history); retarget the `cli/index.ts` lazy import (D4).
- [x] 1.3 Delete `modules/intelligence/` (chat.ts + remaining chat.test.ts pieces; directory gone);
      delete the six session-scoped `BusEvent` members from `types/events.ts` and the dead
      summarizer branches in `lib/bus.ts` (D5); `bun run typecheck` proves nothing referenced them.

## 2. Dev command umbrella

- [x] 2.1 `env.ts`: add `INFLEXA_BUILD_CHANNEL` to the `bakedEnv` block (literal dot access — the
      build.ts scan is literal) + a `devCommandsEnabled()` accessor per design D1 (`INFLEXA_DEV`
      deliberately NOT baked — comment the WHY); unit-test the truth table (release/dev/override).
- [x] 2.2 `cli/index.ts`: wrap the `chat`, `profile`, `run` registrations in the channel gate (D2);
      `.env`/build docs line for the channel; verify `bun run dev` still lists all three.
- [x] 2.3 Build verification (D7): a release-channel build's binary omits the three from `--help`
      and reports them unknown on invocation; the same binary with `INFLEXA_DEV=1` registers them.
      Record the transcript in findings.md. (Smallest build variant; no model/Postgres spend.)

## 3. Verification + docs

- [x] 3.1 Full `bun test` (from cli/!), `bun run typecheck`, `bun run lint` clean; `format:file`
      touched files.
- [x] 3.2 Sync deltas (intelligence-module main spec DELETED; dev-commands created; event-bus,
      cli-core, chat-command merged), archive, update `00-progress.md` + doc 14 (change 3 landed —
      the doc-14 sequence completes).
