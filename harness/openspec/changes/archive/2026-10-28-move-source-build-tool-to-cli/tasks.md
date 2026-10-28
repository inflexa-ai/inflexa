# Tasks

The CLI change `move-source-build-tool-to-cli` (cli tree), groups 1 to 3, comes first. Group 4 of the CLI change comes after this change.

## 1. Remove the tool and the interface

- [x] 1.1 Delete `src/tools/install-from-source.ts` and `src/tools/test/install-from-source.test.ts`. Make sure that no file under `src/` imports them.
- [x] 1.2 In `src/agents/conversation-agent.ts`, remove the import of the tool, the import of `BuildSession`, the `buildSession` dependency with its JSDoc, and the roster entry. Make sure that `bun test src/agents/test/conversation-agent.test.ts` passes.
- [x] 1.3 Remove the build-session types from `src/sandbox/types.ts` and their export block from `src/index.ts`. Make sure that a search of `src/` for `BuildSession` and `install_from_source` finds nothing.
- [x] 1.4 Remove the `install_from_source` assertion from `src/agents/sandbox/test/shared.test.ts`. Make sure that `bun test src/agents/sandbox/test/shared.test.ts` passes.

## 2. The documents

- [x] 2.1 In `CONTEXT.md`, add `acquire-source` to the subcommands of the provisioner entry, and remove the count. Make sure that the list agrees with `images/sandbox-provisioner/provision.py`.

## 3. Verification

- [x] 3.1 Run `bun run format:file` on the changed files under `src/`. Run `bunx oxlint` on the same files. Make sure that `bun run typecheck` passes.
- [x] 3.2 Remove `dist/tools/install-from-source.*`, because `tsc` keeps the output of a deleted source. Then build the harness with `bun run build`, so that the CLI reads the new `dist/`. Make sure that `dist/` holds no `install-from-source` file.
