# Design

## Context

The harness declares the `BuildSession` interface (`harness/src/sandbox/types.ts:116-198`) and the `install_from_source` tool (`harness/src/tools/install-from-source.ts`). The conversation agent adds the tool when the composition binds `buildSession` (`harness/src/agents/conversation-agent.ts:377-381`). The CLI realizes the interface in `cli/src/modules/libs/build-session.ts`, and it binds the realization in the conversation deps (`cli/src/modules/harness/runtime.ts:1219-1221`).

A host tool gets the same `ToolContext` as a harness tool: `ask` with `grantKey`, `signal`, and the session scope. The barrel exports `defineTool`, `AskRejectedError`, and the tool types (`harness/src/index.ts:167, 179, 263`).

The loop cuts each tool result over the tool-result cap. It keeps the text of the result for `read_tool_output`, within the kept-text limit of the loop (`harness/src/loop/run-agent.ts:1290-1321`). This is true for each tool, a host tool included. A host tool cannot hold the tool-output store, because `assembleCoreRuntime` makes the store (`harness/src/runtime/assemble.ts:323`) after the CLI makes `hostTools`.

The CLI reads the harness through the `dist/` output of the linked working copy. Thus a harness source change reaches the CLI typecheck only after a harness build.

## Goals / Non-Goals

**Goals:**

- The tool behaves the same after the move. Each behavior that the hardening commit `225ea9e6` added stays:
  - the start ask
  - the plan, command, and commit asks with the session grant key
  - the host name rule
  - the session lock
  - the cancel through `ctx.signal`
  - the exec output limit of the realization.
- The harness gets no new export.

**Non-Goals:**

- No change to the CLI realization of the session, to the provisioner, or to the store shape.
- No change of the `BuildSession` contract from a rejected promise to a `Result`.

## Decisions

### D1: The interface keeps its promise contract

The types move without change into `cli/src/modules/libs/build-session.ts`, above `CliBuildSession`. The interface methods keep the promise that rejects. The realization rejects by design when the abort signal fires, and the tool already changes each rejection into a `failed` result. Thus each `try`/`catch` of the tool bridges a throw into a `Result`, which the neverthrow rule of the CLI permits.

Alternative: change the interface to `ResultAsync`. Rejected, because the change reaches the whole realization, and the move must not change behavior.

`CliBuildSession` stays. It widens `start` to a null analysis, and the commit refuses that null as a binding fault.

### D2: The tool moves as one file, with one change to its output

The tool goes to `cli/src/modules/harness/source_build_tool.ts`, beside `inflexa_tool.ts`. The factory is `createInstallFromSourceTool({ buildSession })`. The tool id, the schema, the description, `describeCall`, the asks, the grant key `install_from_source:<sessionId>`, the notes, and the session queue stay the same. The tool imports the harness API from the `@inflexa-ai/harness` barrel alone. The `oxlint-disable` directive above the host name pattern goes away, because the CLI lint has no ban on a regular expression literal.

The one change is the exec result. The tool returns the whole combined output, and the result type loses `kept`. The tool loses `RESULT_BUDGET`, its own cut loop, and the store put. The description keeps its sentence about `read_tool_output`, because the loop cut now gives that behavior.

Alternative: keep the cut of the tool and drop only the store put. Rejected, because the cut of the tool keeps the head alone. The loop excerpt keeps the head and the tail (`harness/src/loop/tool-output.ts:85-99`), and the tail of a build log holds the error.

### D3: Two harness helpers become local helpers

`errorMessageOf` and `textOf` are not in the barrel, and the CLI has no shared equivalent. Each has one caller, thus a local function in the tool file replaces each. Each local function keeps the rule of the harness helper (`harness/src/lib/thrown.ts:20-24`, `harness/src/lib/unknown-text.ts:21-25`):

- The failure text is the own string `message` of any object, not only of an `Error`.
- Another value gives its text form: a string as itself, a primitive through `String`, and an object as JSON when it can.

### D4: The composition gives the tool through `hostTools`

`runtime.ts` adds `createInstallFromSourceTool({ buildSession: seams.createBuildSession(...) })` to `hostTools`, with the same limits as today. The conversation deps lose `buildSession`. The engine gate of the boot stays the gate of the tool: a boot with no working engine fails before the conversation composition.

### D5: The tests move with the tool

`cli/src/modules/harness/source_build_tool.test.ts` gets each case of `harness/src/tools/test/install-from-source.test.ts`, with these changes:

- The roster cases go away. The roster test of `runtime.test.ts` covers the roster.
- The cases of the kept output go away, because the loop owns that path.
- The short-log case becomes a case that an exec returns the whole combined output, also past the tool-result cap.
- A local tool-context builder replaces the harness fixture, as in `inputs_tool.test.ts`.

### D6: One spec owns the tool

The CLI capability `source-build-session` gets the requirements of the harness capability of the same name. The interface requirement of the harness joins the binding requirement of the CLI. The moved requirements give the contract of the tool and the session. The existing requirements give the container realization. Thus some rules show at both levels, as they did across the two trees.

The sibling harness change removes each requirement, and the archive removes the harness capability. The Purpose line of the CLI spec changes at the sync, because a delta does not carry a Purpose.

### D7: The tool passes on the throw of an ask

The tool catches the throw of `ctx.ask` only to stop the session on a rejection. Then it throws the same value again, and an abort keeps the session. The loop maps a throw of `execute` to an execution-denied result, and that ends the turn. The other host tools let the same throw pass with no catch (`src/modules/harness/inflexa_tool.ts:551-552`). The rethrow is necessary, because the session must stop before the denial reaches the loop. Thus the `throw` stays, with a comment that gives this reason.

Alternative: change the throw into a `failed` result. Rejected, because the turn then continues after the user refused.

## Risks / Trade-offs

- [The CLI reads a stale harness `dist/`.] → Build the harness before the CLI typecheck and the CLI tests.
- [The loop excerpt of a JSON result is text, not JSON.] → The head of the excerpt holds `status`, `exitCode`, and `timedOut`. The tail holds the end of the log. `read_tool_output` serves the kept text.
- [The loop keeps at most 1 MiB of a text, a head half and a tail half (`harness/src/loop/tool-output.ts:22, 77-82`).] → The old tool had the same limit, because it kept its text through the same function. The realization also keeps at most 1 MiB of each stream.
- [The loop keeps the text only when the agent declares `read_tool_output`.] → The conversation agent declares it when the store is bound. `assembleCoreRuntime` always binds the store.
