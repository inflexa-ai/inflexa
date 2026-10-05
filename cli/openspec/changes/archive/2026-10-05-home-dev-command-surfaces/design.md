## Context

`src/modules/harness/` holds the harness embedder. Three of its files serve the dev channel alone: `chat.ts`, `run.ts`, and the `inflexa profile` command actions inside `profile.ts`. The registration gate at `src/cli/index.ts:296` is the only record of that fact in the code. The `dev-commands` spec is the only record in the specs.

Two files block a plain move. `profile.ts` mixes three product helpers with the dev command actions. `chat_printer.ts` mixes six TUI readers with the stdout printer. A move of either file whole would drag product code into a dev directory, or leave dev code outside it.

The constraint that shapes every destination is the module dependency rule of `cli/CLAUDE.md`: a module imports other modules acyclically, and no module imports `tui/`. A dev directory adds one more direction. `dev/` can import product code, and no product file can import `dev/`.

## Goals / Non-Goals

**Goals:**

- The tree states the channel of a file, beside the registration gate that already states it.
- Each helper that both a product surface and a dev surface call lives in the module that owns its subject.
- No file keeps a name that describes none of its residents.
- Behavior does not change. Every command keeps its output, its exit codes, and its prompts.

**Non-Goals:**

- The repeated pre-flight sequence stays as it is. The config gate, then `ensureSandboxImage`, then the analysis lock appear at `src/tui/app.launch.tsx:46-54`, `src/modules/harness/chat.ts:94-105`, and `src/modules/harness/run.ts:344-390`. A shared pre-flight helper is a separate question.
- The error contract of `ensureSandboxImage` stays as it is. See the trade-off below.
- The dev commands themselves do not change. Their gate, their flags, and their specs stay.

## Decisions

### Dissolve `profile.ts` instead of a rename

**Chosen:** send the three product helpers to three different modules, and let the file cease to exist.

**Alternative rejected:** rename `profile.ts` to a name such as `boot_preflight.ts` and keep the three together. The three answer to two different consumer sets, and one of them is not a boot concern at all: `seedProfileLedger` writes a ledger row at trigger time. A rename groups the three by what a caller needs before boot, which is a caller's schedule and not a domain. The new name would still describe only two of its three residents.

### `describeBootError` joins `runtime.ts`

`runtime.ts` declares the `HarnessBootError` union at `:181` and `bootHarnessRuntime` at `:406`. `describeBootError` is a total switch over that union, and the `never` guard at `profile.ts:115-118` makes an unmapped variant a type error. Colocation makes a new variant cost one file to edit.

**Alternative rejected:** a new file `src/modules/harness/boot_error.ts`. It separates a union from its own exhaustive mapper for no gain. A shorter name such as `boot.ts` also collides in a reader's mind with `src/tui/hooks/boot.ts`, which holds the TUI boot store.

### `ensureSandboxImage` joins `libs/pull.ts`

The spec that owns this function is already `lib-store-provisioning`: the requirement at `openspec/specs/lib-store-provisioning/spec.md:116` is titled "`ensureSandboxImage` pulls the image from GHCR when missing". `pull.ts` owns the sandbox image, and `pull.ts:20-23` imports the exact set that the function uses. The inline presence lookup at `profile.ts:133` is a copy of the private `imagePresent` at `pull.ts:86-88`, and the move collapses the copy.

One rule of that module holds: `pull.ts:56-58` states that the module imports nothing from `modules/harness`. `ensureSandboxImage` imports nothing from `modules/harness`, so the direction stays clean.

**Alternative rejected:** keep it under `modules/harness/`. The function is about a container image, not about the harness runtime, and its own spec already places it in the other module.

### `seedProfileLedger` joins `profile_trigger.ts`

`profile_trigger.ts` is the only product consumer (`:17,125`), and it already documents the shared ledger contract at `:26` and `:88`. The function cannot go into `dev/`, because `profile_trigger.ts` is product code and a product file cannot import `dev/`.

**Alternative rejected:** a new shared file for the ledger seed. The function is 9 lines and has two callers. A file for it adds a hop with no reader gain.

### Split `chat_printer.ts`, and fold its printer into `dev/chat.ts`

`src/tui/hooks/conversation.ts:21` imports six readers. Five of them — `isSubAgentEvent`, `readAskPart`, `readPlanCard`, `readRunCard`, and `subAgentActivityLabel` — are also called by the printer, at `chat_printer.ts:280`, `:281`, `:331`, `:349`, and `:377`. Two consumers each, so those five stay in `src/modules/harness/chat_printer.ts` as shared product code.

`ChatSink`, `ChatPrinter`, `PrinterOptions`, and `createChatPrinter` build the stdout REPL printer, and `chat.ts:26` is their one caller. They fold INTO `dev/chat.ts`, not into a `dev/chat_printer.ts`. `cli/CLAUDE.md:69-71` forbids a separate file for a single-caller helper, and a new file earns its place only with a second caller. `dev/chat.ts` reaches about 520 lines as a result.

The fold leaves the printer with an import back to `chat_printer.ts` for the five readers. That direction runs from `dev/` toward the product, which is the sanctioned one.

**Alternative rejected:** a `dev/chat_printer.ts` that mirrors the old file name. It reads as symmetric with the `profile.ts` split, but it makes a file for one caller against an explicit repository rule.

### `eventDepth` joins `conversation.ts`

`eventDepth` (`chat_printer.ts:104`) has one caller, `conversation.ts:360`, and the printer never uses it. It is not shared code, so the single-caller rule sends it to its caller.

It reads an event's `source` through the private `eventSource` helper (`chat_printer.ts:74`), which `isSubAgentEvent` and `subAgentActivityLabel` also use. Rather than export that helper, `eventDepth` inlines the one-expression presence read at its new home. To export a private helper for one function outside the file widens the module surface for less gain than the inline costs.

### One `Spinner` alias, in `lib/cli.ts`

`type Spinner = ReturnType<typeof spinner>` is declared twice, at `profile.ts:36` and `run.ts:62`. Both name the same clack spinner object, and both exist because each file passes a spinner across a function boundary.

The one alias goes to `src/lib/cli.ts`. That file is already the `@clack/prompts` boundary of the repository (`cli.ts:1`) and it exports every other prompt helper. `lib/` imports no module, and a type over a clack return value imports none either, so the dependency rule of `cli/CLAUDE.md:595-600` holds.

`modules/infra/setup.ts` and `modules/embedding/setup.ts` also build spinners, but each one stays inside the function that made it, so neither declares the alias and neither changes.

**Alternative rejected:** a new shared file for the alias. One type declaration does not earn a file, and `lib/cli.ts` already owns this dependency.

### The dev status readers get their own file inside `dev/`

`friendlyStepLabel`, `readNewestWorkflowStep`, `runWorkflowFamily`, `readRunProgress`, `formatElapsed`, `waitForTerminalStatus`, and `withStatusPool` have two callers after the move: `dev/profile.ts` and `dev/run.ts`. A shared file inside `dev/` keeps them out of both command files, and `dev/status.ts` names what they read.

### One change, two ordered phases

Phase 1 dissolves the two mixed files. Phase 2 moves the dev code. The order matters for the reviewer: phase 2 then carries no split, so its diff is a file move and an import path change.

**Alternative rejected:** two separate changes. The second change has no value on its own, and issue #56 asks for one outcome.

## Risks / Trade-offs

**Two error styles land in one file** → `ensureSandboxImage` calls `fail()`, which prints to stderr and exits the process (`src/lib/cli.ts:12-15`). `sandboxPull` returns a `Result` (`pull.ts:115`). The move puts both styles in `pull.ts`. A conversion to `Result` would change what every caller does on a missing image, and this change is a location change. The function keeps its contract, and the file comment records why the two styles sit together.

**A missed importer** → the change updates each importer and adds no shim, per `cli/CLAUDE.md:396`. TypeScript and the linter reject an unresolved import, so a miss fails the build rather than shipping.

**`runtime.ts` grows to about 1197 lines** → accepted. The alternative separates a union from the mapper that exhausts it, and that costs a reader more than the length does.

**The `dev/` boundary guard covers a static import only** → a `no-restricted-imports` rule in `eslint.config.js` fails a build when a product file imports `dev/`. It exempts the files under `dev/`, and nothing else.

Two facts shaped it, and both cost a wrong first attempt. The pattern matches the import STRING, not a resolved path, so `**/modules/harness/dev/*` reads as armed while matching nothing from inside `modules/harness/` — a sibling writes `./dev/chat.ts`. The pattern is `**/dev/*`, confirmed against a sibling form and a deep form.

`no-restricted-imports` never visits an `ImportExpression`, so a dynamic `await import("./dev/…")` from a product file still passes. Covering it wants `no-restricted-syntax`, which REPLACES rather than extends per block, and threading that through the `src/cli/**` block would cost the `.action()` ban its scope. The dynamic form is what the registry uses and what a product file has no reason to write, so that gap stays a review item.
