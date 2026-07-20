## 1. buildProgram factory refactor

- [x] 1.1 Extract the module-singleton commander root in `src/cli/index.ts` into a `buildProgram()` factory that returns a fresh root with the full command tree (lazy-imported actions, `exitOverride`, channel-gated dev commands preserved).
- [x] 1.2 Update `src/index.ts` to obtain its program from `buildProgram()` and dispatch, preserving the existing `CommanderError` handling.
- [x] 1.3 Verify `bun run dev`, `--help`, `--version`, and a normal command still behave identically (registration + entrypoint unchanged in observable behavior).

## 2. Classifier

- [x] 2.1 Add a classify function that builds a `buildProgram()` instance with each command's action replaced by a sentinel throwing the resolved command, `exitOverride` set, and output silenced via `configureOutput`.
- [x] 2.2 Parse the argv (`from: "user"`) and map the outcome: `helpDisplayed`/`help`/`version` → introspection; sentinel → action (capture the resolved subcommand path via `.parent` walk and the CLI-parsed options); parse-error code → malformed.
- [x] 2.3 Derive the grant key from the resolved subcommand path only (command names, no argument/option values).
- [x] 2.4 Defensively shell-tokenize a single-element argv that contains whitespace before classification.

## 3. The run_inflexa tool

- [x] 3.1 Define `run_inflexa` via the harness `defineTool` (input `{ argv: string[] }`), with a generic description that teaches the agent to explore the CLI via `--help` (no refs-specific vocabulary).
- [x] 3.2 Classify the argv: introspection → skip approval; malformed → return a tool error without spawning; action → build the `AskRequest` (`command` = exact argv, `grantKey` = subcommand path, `detail` = the argv/what runs) and `await ctx.ask`.
- [x] 3.3 Comment the accepted subcommand-path grant footgun (an `always` covers other flags on the same path) at the grant-key construction site, stating the invariant that the displayed `command` always carries the exact argv at consent time.
- [x] 3.4 Resolve dev vs release invocation from `env.isDevelopment`: dev → `bun run src/index.ts …`; release → `process.execPath …`.
- [x] 3.5 Spawn via `Bun.spawn` (argv array, no shell), `stdin: "ignore"`, `stdout`/`stderr` piped and captured, bounded by a timeout that terminates a non-exiting child.
- [x] 3.6 Return `{ exitCode, stdout, stderr }` (output bounded/truncated) to the model; a timeout returns a timeout result.

## 4. Wiring

- [x] 4.1 Construct the tool at the conversation composition root and pass it via `hostTools` in the conversation deps (`src/modules/harness/runtime.ts:908`).
- [x] 4.2 Confirm the deny-by-default path: the tool is present but any `ctx.ask` off the interactive TUI (REPL/headless) is denied by the harness default.

## 5. Tests

- [x] 5.1 Classifier: `["--help"]`, `["refs","--help"]`, `["help","refs"]`, `["--version"]` → introspection; `["refs","download","x","--yes"]` → action with path `refs download`; `["refs","download","x","--","--help"]` → action (not introspection); `["bogus"]` / `["refs","--nope"]` → malformed.
- [x] 5.2 Grant key: an action argv yields `grantKey` = the bare subcommand path with no argument/option values; two different datasets on `refs download` produce the same key.
- [x] 5.3 Tool: introspection spawns without raising `ctx.ask`; an action raises `ctx.ask` with `command` = exact argv and `grantKey` = subcommand path; a rejection does not spawn; a malformed argv returns an error without spawning.
- [x] 5.4 Subprocess: `stdin` is ignored (a non-`--yes` `refs download` declines rather than hangs); a child that does not exit is terminated by the timeout.
- [x] 5.5 Invocation resolution: dev resolves to the bun entry point, release to `process.execPath` (unit-test the pure resolver over a channel input).

## 6. Verify

- [x] 6.1 `bun run typecheck`, `bun run lint`, and `bun test` pass; run `bun run format:file` on changed `src/` files.
- [x] 6.2 `openspec validate add-inflexa-cli-tool --strict` passes.
- [x] 6.3 Confirm the CLI builds against the linked local harness carrying `hostTools` + `AskRequest.grantKey` (harness change `add-host-conversation-tools`).
