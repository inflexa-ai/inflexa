# Tasks: pack-the-report-page-assets

## 0. The harness link

- [x] 0.1 Run `bun install --frozen-lockfile` from `harness`. The three packages that hold the assets are dependencies of the harness, and a checkout can carry an install that predates them.
- [x] 0.2 Run `bun run harness:local` from `cli`. The manifest reaches the front door of the harness in a change that is not published yet, thus the link comes first.

## 1. The build

- [x] 1.1 Read the asset manifest in `scripts/build.ts`, from the module that holds it and not from the front door. The manifest is pure data, and the front door evaluates the whole runtime graph of the harness.
- [x] 1.2 Resolve the entry point of the harness, then resolve each specifier against that entry. Use the module resolution of the ESM loader, because the export map of the harness declares no `require` condition.
- [x] 1.3 Pack the bytes of each entry as `assets/<file>`, beside the two trees that the walk collects today. One archive carries all three, thus one hash covers them.
- [x] 1.4 Refuse the build when a specifier resolves to no file. Name that specifier, in the shape that the missing-tree refusal already uses.
- [x] 1.5 Refuse the build when the manifest is empty. An empty manifest writes no assets directory, and the boot would then re-extract on each run with nothing to say so.

## 2. The materialization

- [x] 2.1 Give back the assets directory beside the skills directory and the templates directory. The return is the one value that proves the extract ran.
- [x] 2.2 Make the warm-path guard cover each of the three directories. A hash directory that holds two of them is not complete.
- [x] 2.3 Widen the boot message of a failed materialization to name the assets beside the skills and the templates. One archive carries the three, thus the message that names two of them is short one.

## 3. The binding

- [x] 3.1 Bind the asset lookup at the composition root, over the assets directory that the materialization gave back. The release gate of the materialization holds the binding too.
- [x] 3.2 Map a specifier onto its file with the same manifest that the build read. Throw for a specifier that the manifest does not carry.
- [x] 3.3 Comment the throw. The preview tool wraps the call and turns a throw into a typed outcome, thus the throw is the protocol of the seam.

## 4. The coverage

- [x] 4.1 Cover the pack: each manifest entry lands in the archive under its staged name, and an unresolvable specifier refuses the build.
- [x] 4.2 Cover the materialization: a fresh unpack writes the three directories, and a directory that holds two of them re-extracts.
- [x] 4.3 Cover the lookup: a manifest specifier gives the materialized path, and an unknown specifier throws.
- [ ] 4.4 Build a binary, and render one report page with it. No automated case reaches a compiled binary, thus this manual step is the one proof that the whole path works.

## 5. The gates

- [x] 5.1 Run `bun run format:file` on the changed files under `src/`.
- [x] 5.2 Run `bun run typecheck` and `bun run lint`.
- [x] 5.3 Run the targeted files of the changed modules, and never the whole suite.
- [x] 5.4 Run `openspec validate pack-the-report-page-assets --strict`.
