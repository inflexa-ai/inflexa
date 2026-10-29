# Proposal

## Why

The `install_from_source` conversation tool and its `BuildSession` interface live in the harness, but only the CLI needs them. An acquisition is a host action, and the conversation agent already reaches the other acquisition path, `inflexa store add`, through the `run_inflexa` host tool. The tool text also names the layout of the CLI: `/work/src`, `/work/out`, the apt snapshot, the pak hosts, and the build record fields. The rules of the root `CLAUDE.md` ("Agent-facing content") and rule 8 of `harness/CLAUDE.md` forbid a layout in harness content. A cloud embedder makes its environment in a different way, thus the tool is a need of the CLI.

## What Changes

- The `install_from_source` tool moves from the harness into the CLI as a host tool. The CLI adds it to the conversation agent through the `hostTools` list.
- The `BuildSession` interface and its types move from the harness into the CLI build-session module, beside the CLI realization.
- The tool returns the whole output of an exec. The loop of the harness cuts a result over the tool-result cap. It keeps the text for `read_tool_output`, within the kept-text limit of the loop. Thus the tool keeps no output itself.
- Each behavior of the tool stays the same. This includes the asks, the session grant key, the host name rule, the session lock, the cancel, and the tool text.
- The tests of the tool move into the CLI. The tests of the kept-output path of the tool go away, because the loop owns that path.
- The CLI composition stops the bind of the build session in the conversation deps.
- The sibling harness change `move-source-build-tool-to-cli` (harness tree) removes the tool, the interface, and the `source-build-session` capability of the harness.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `source-build-session`: the CLI keeps the interface, and it adds the tool through `hostTools`. The requirements of the harness capability of the same name join this capability. The long-log rule refers to the loop cut of the harness.

## Impact

- `cli/src/modules/libs/build-session.ts`: it declares the `BuildSession` interface and its types. It stops the import of these types from `@inflexa-ai/harness`.
- A new host tool beside `cli/src/modules/harness/inflexa_tool.ts`, with the tests that move from `harness/src/tools/test/install-from-source.test.ts`.
- `cli/src/modules/harness/runtime.ts`: the `hostTools` list gets the tool, and the conversation deps lose `buildSession`.
- `cli/src/modules/harness/runtime.test.ts`: the roster test now expects the tool in `hostTools`.
- The harness gets no new export. The harness never published `BuildSession`, thus no consumer on npm breaks.
- The CLI reads the harness through the build output of the linked working copy. Thus a new harness build is necessary before the CLI typecheck.
