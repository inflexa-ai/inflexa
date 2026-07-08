# retire-proxy-chat-dev-umbrella — Design

## Context

Change 3 (final) of doc 14. Verified ground: `modules/intelligence/chat.ts`'s only importer is
`modules/harness/runtime.ts:50` (the helpers); the six session-scoped `BusEvent` members are
emitted only by that engine and consumed by nothing (`types/events.ts` + `lib/bus.ts`'s log
summarizer are the only other references); `sessions` remain the live launch-identity store
(`createSession` on every new/resume; threads bind 1:1) — only `messages`/`parts` lost their
writer. `scripts/build.ts` bakes compile-time constants from `env.ts`'s `bakedEnv` block (literal
`process.env.<NAME>` accesses collected by source scan; the build fails on a missing baked var).

## Goals / Non-Goals

**Goals:** delete the dead engine + its bus vocabulary; retire `modules/intelligence/`; ship
release binaries whose command surface is the product only; keep `bun run dev` fully equipped;
keep an explicit runtime escape hatch for shipped binaries.

**Non-Goals:** SQLite schema changes (frozen tables stay readable); deleting
`listSessionMessages`/`listRecentSessionMessages` queries (harmless reads over frozen data — one
consumer died, the queries stay for the sessions history until a future cleanup decides); any
harness change; removing the `sessions` command (it lists LIVE identity rows).

## Decisions

**D1 — Channel mechanism: one new baked var, presence-based.** `env.ts` gains
`INFLEXA_BUILD_CHANNEL` in the `bakedEnv` block (so `build.ts` bakes it; its missing-guard forces
release builds to declare it — CI/`.env` sets `release`). The accessor:
`devCommandsEnabled() = bakedEnv.buildChannel !== "release" || process.env.INFLEXA_DEV === "1"`,
where `INFLEXA_DEV` is deliberately NOT baked (stays a runtime read even in a compiled binary —
the escape hatch). `bun run dev` has no channel var → dev. *Alternative rejected*: keying off the
already-baked `INFLEXA_GIT_COMMIT` (compiled ⇒ prod) — conflates "compiled" with "release" and
breaks compiled dev builds (`build:all` variants).

**D2 — Registration gate, not runtime refusal.** `cli/index.ts` wraps the three registrations
(`chat`, `profile`, `run`) in the channel check: in a release binary the commands do not exist
(absent from `--help`, unknown-command error on invocation) rather than existing-but-refusing.
Honest surface; zero dead lazy-import paths in the binary.

**D3 — Helper home: `modules/proxy/models.ts`.** `readApiKey`/`resolveModelId`/
`pickDefaultModel`/`ChatSetupError` are proxy-endpoint concerns (key discovery, `/models`
ranking); `modules/proxy/` already owns the CLIProxyAPI lifecycle. `runtime.ts:50` retargets.
Move, don't re-export (no shims — repo rule).

**D4 — Sessions command home: `modules/analysis/sessions.ts`.** Sessions are analysis-scoped
launch identity (live). The command's behavior is unchanged. `cli/index.ts` lazy-import retargets.

**D5 — Bus contract shrink.** The six session-scoped members leave `BusEvent`; `prov.*` stays; the
`lib/bus.ts` log summarizer drops its dead branches (including the card-kind narrowing that
existed only for `part.updated`). The event-bus spec's "publish via Bus.emit" scenario re-examples
onto a prov event.

**D6 — `modules/intelligence/` deletion mechanics.** `chat.ts` + `chat.test.ts` deleted; the
directory ends empty and is removed. The `intelligence-module` capability's requirements are all
REMOVED in the delta; at sync the main spec directory is deleted (a capability with zero
requirements is retired — same end-state the #32 inversion precedent produced for superseded
contracts).

**D7 — Verification without spend.** Unit: the channel accessor truth table. Build-level: run
`bun run build` (or the smallest variant) with `INFLEXA_BUILD_CHANNEL=release`, execute the binary
with `--help` and assert `chat|profile|run` absent, then with `INFLEXA_DEV=1` assert present; run
`bun run dev -- --help`-equivalent asserting present. No model, no Postgres, no sandbox.

## Risks / Trade-offs

- [Baked-var scan is literal] → the new var must appear as a literal `process.env.INFLEXA_BUILD_CHANNEL`
  dot access inside the `bakedEnv` block (build.ts's regex collects it) — a computed access would
  silently skip baking.
- [Compiled dev variants] → `build:all` flavors must pass an explicit channel; the missing-guard
  makes forgetting loud, not silent.
- [Frozen tables without a writer confuse future readers] → the freeze is recorded in the synced
  specs (intelligence-module removal notes) and the `sessions` command JSDoc states messages/parts
  are historical.
- [Help/completion drift between channels] → the gate wraps registration only; help is generated
  from the registry, so it stays consistent by construction.
