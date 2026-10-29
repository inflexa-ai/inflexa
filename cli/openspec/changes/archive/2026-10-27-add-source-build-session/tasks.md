# Tasks

## 1. The session module

- [x] 1.1 Create `cli/src/modules/libs/build-session.ts`: start (held provisioner container with the entrypoint override that applies the allowlist then holds, scratch volume, exploration egress of the git host alone, pristine snapshot via clone at the resolved commit or folder copy, working copy for the session), restart under an approved list, exec (runtime exec, fresh shell, per-command timeout, non-root default with a root marker), stop (container removal), and the ref-resolution rule (a named ref to its commit, an absent ref to the default-branch head, resolved before the exploration). Verify with a new `build-session.test.ts` that pins the runners and asserts the container args, the entrypoint override, the restart behavior, the exec shape, the user rule, the egress lists, and the ref resolution.

- [x] 1.2 Add the tree-hash step for a folder source (one short provisioner run over the pristine copy, so the hash comes from the provisioner's own function) and the `GITHUB_PAT` containment (the clone exec env alone). Verify with tests that assert the hash invocation and that no exec env besides the clone holds the token.

## 2. The flight and the composition

- [x] 2.1 Add the `acquire-source` launch path to `cli/src/modules/libs/provisioner.ts` (session egress constant, snapshot and script arguments, both image digests in the environment) and the `source` outcome kind to `acquireReportSchema` in `store_flight.ts`. Verify with tests over the pinned runner that assert the launch env and the report parse.
- [x] 2.2 Wire the commit flow of the session into the flight tail: the source flight row created at the clean run and keyed by the qualified pin, one `acquire-source` run, `runLoadCheck` with the link-rule results, `commitStagedNodes`, `extendFarm`, a `failed` row on refusal with the phase named, and a farm-extension failure that does not fail the flight. Make the retry route of the flight surfaces refuse a source row. Verify with tests that drive stubbed runners through a green path and a red link rule, asserting no advertised state on red and the retry refusal.
- [x] 2.3 Add `source` to `R_SUBTREES` in `cli/src/modules/libs/composition.ts`, select the `source` subtree for a qualified pin in the link plan, read `.inflexa-build.json` in `lockPackageEntry` for a qualified pin, and add the record marker to `NOT_CONTENT`. Verify with `composition.test.ts` cases: the lock entry carries the source and the package links under `r/source`.
- [x] 2.4 Add the two one-name refusals: the R link pass refuses two closure members of one identity name (the Python `isVersionCollision` path today), and `pickVersion` refuses a version that two directories of one identity answer, naming both directories, on the store-link path and the farm-extension seam. Verify with `composition.test.ts` cases: the CRAN-plus-fork farm link refuses with both directories named, and the `r:SeedMatchR==2.0.0` pool query against both refuses.

## 3. The binding

- [x] 3.1 Bind the `BuildSession` interface at the CLI composition root in the conversation composition deps, gated on a working container runtime, with no `hostTools` contribution of the tool. Verify with a composition test that the roster holds the tool exactly once when the runtime resolves and not otherwise.

## 4. Verification of the CLI change

- [x] 4.1 Run `cd cli && bun test src/modules/libs` and `cd cli && bun run typecheck`; record that the pre-existing `src/tui/layout/message_block.tsx` failure on `main` is the only typecheck failure. Validate both changes with `openspec validate add-source-build-session` in `harness` and in `cli`.
