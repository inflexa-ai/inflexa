# Proposal

## Why

The `install_from_source` conversation tool and its `BuildSession` interface are a need of the CLI alone. An acquisition is a host action, and the tool text names the layout of the CLI: `/work/src`, `/work/out`, the apt snapshot, the pak hosts, and the build record fields. Rule 8 of `harness/CLAUDE.md` forbids a layout in harness content. The sibling CLI change `move-source-build-tool-to-cli` (cli tree) moves the tool and the interface into the CLI as a host tool.

## What Changes

- **BREAKING** (unpublished interface): the harness removes the `BuildSession` interface and its types from `sandbox/types.ts` and from the barrel. No harness release published them.
- The harness removes the `install_from_source` tool and its tests.
- The conversation agent loses the `buildSession` dependency and the roster entry of the tool.
- The sandbox roster test loses its assertion about the tool, because the harness no longer knows the tool.
- The `source-build-session` capability of the harness goes away. Its requirements join the `source-build-session` capability of the CLI.
- `CONTEXT.md` lists the `acquire-source` subcommand of the provisioner. The list omits it today.

The farm lock `source` field, the `r/source` path on `R_LIBS_SITE`, the `source` track of `list_available_packages`, and the package-store specs stay the same.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `source-build-session`: each requirement goes away, thus the archive removes the capability.

## Impact

- `src/tools/install-from-source.ts` and `src/tools/test/install-from-source.test.ts`: removed.
- `src/sandbox/types.ts`: the build-session types go away.
- `src/index.ts`: the export of the build-session types goes away.
- `src/agents/conversation-agent.ts`: the `buildSession` dependency and the roster entry go away.
- `src/agents/sandbox/test/shared.test.ts`: the assertion about the tool goes away.
- `CONTEXT.md`: the provisioner entry names `acquire-source`.
- The CLI, which links the working copy, must remove its own use of these types in the same change.
