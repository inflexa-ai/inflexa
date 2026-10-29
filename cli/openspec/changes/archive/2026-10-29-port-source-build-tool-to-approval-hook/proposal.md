# Proposal

## Why

The harness removed `ctx.ask` and `AskRejectedError` from the tool context. A tool now gives its approval request through the `approval` hook, and the loop asks the user before `execute` runs. The `install_from_source` tool still asks from inside `execute`, thus the CLI does not compile.

## What Changes

- Move each ask of `install_from_source` into the `approval` hook. One pure decision function gives the ask of each call. The `approval` hook and `execute` both use it.
- The first build command and its plan share one ask. An amended plan also shares one ask with its command.
- A denied call runs nothing. The session stays open, because the tool does not run on a denial. **BREAKING** for the spec: a rejection no longer ends the session.
- The plan ask and the commit ask carry a grant key that holds a digest of the approved content. Only a plain build command keeps the session grant key. Thus an "always" answer never approves a later plan or a different script.
- The `approval` hook records its decision for each call. `execute` makes the decision again inside the queue of the session. If the decision changed, `execute` runs nothing and returns a stale-approval result.
- Remove the rejection path: `AskRejectedError`, `endOnRejection`, `stopAfterRejection`, and their tests.
- Correct the comments of the CLI that still name `ctx.ask`.

## Capabilities

### New Capabilities

### Modified Capabilities

- `source-build-session`: the approval rules of the start, the plan, the command, and the commit change to the `approval` hook. A rejection leaves the session open. The order rule of the calls of one session covers the stale approval. The cancel rule no longer names an abort during an ask of the tool.

## Impact

- `cli/src/modules/harness/source_build_tool.ts` and `source_build_tool.test.ts`.
- Comments in `cli/src/modules/harness/inflexa_tool.ts`, `inflexa_tool.test.ts`, and `cli/src/cli/agent_policy.ts`.
- `cli/openspec/specs/source-build-session/spec.md`.
- No harness change, and no new dependency.
