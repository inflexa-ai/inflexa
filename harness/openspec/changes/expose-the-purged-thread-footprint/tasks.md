# Tasks: expose-the-purged-thread-footprint

## 1. The layout helper

- [x] 1.1 Add the report-session directory helper to `workspace/paths.ts`, beside the preview helpers. It takes the thread id, and it gives a workspace-root-relative path, exactly as `previewDir` does. Assert the id, as each sibling builder does.
- [x] 1.2 Call the helper in `preview-report.ts`, joined onto the root that the tool resolves already.
- [x] 1.3 Call the helper in `examine-page.ts`, which reads the relative form as it is.
- [x] 1.4 Export the helper from `src/index.ts`. An embedder removes the files, and it must restate no layout.

## 2. The purge return

- [x] 2.1 Read the subtree of the purge inside the transaction, before the deletes remove it. The walk already names that set.
- [x] 2.2 Give back the erased thread ids from `purgeThread`, as a readonly array. An absent thread gives an empty array.
- [x] 2.3 Widen the `ThreadStore` interface for the new return, and keep the error channel as it is.
- [x] 2.4 Make sure that the internal caller in `app/spawn-report-session.ts` still compiles and behaves as it does. It chains the purge, and it reads no value from it.

## 3. The coverage

- [x] 3.1 Cover the return: a purge of a parent names the parent and each child, and a purge of an absent thread names nothing.
- [x] 3.2 Cover the helper: the directory of one thread differs from the directory of another, and the preview writes under it.
- [x] 3.3 Make sure that the existing purge cases still pass. The rows must go as they go today.

## 4. The gates

- [x] 4.1 Run `bun run format:file` on the changed files under `src/`.
- [x] 4.2 Run `tsc -p tsconfig.json`.
- [x] 4.3 Run the targeted test files of the changed modules, and never the whole suite.
- [x] 4.4 Run `openspec validate expose-the-purged-thread-footprint --strict`.
