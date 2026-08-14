## Why

A report page is self-contained. It references a chart runtime and five fonts as sibling files under `assets/`. The preview tool copies each one out of the installation of the harness, and the default lookup resolves a module specifier through `createRequire`.

That default serves an npm consumer and a dev run. The compiled binary carries no `node_modules` tree, thus the resolution walks the working directory upward and finds nothing. The tool then returns `write-failed` on the machine of a user. CI never meets the fault, because CI always has an installation.

The harness side is in place. `assembleCoreRuntime` accepts `resolveReportPageAsset`, and the preview tool takes the lookup that it forwards. The CLI binds nothing, thus the default runs and the page never lands.

## What Changes

- The build packs each manifest file into the binary, beside the skills and the templates that it packs today. One archive carries all three trees, thus one hash and one extraction serve them.
- A specifier that does not resolve refuses the build. The manifest is the source of the file set. Thus a harness version that adds a font cannot ship a binary that misses it.
- The first run materializes the assets beside the skills and the templates, under the same hash directory.
- The composition root binds the asset lookup in a release build. A dev run binds nothing, thus the default resolves against the installation of the harness.

## Capabilities

### Modified Capabilities

- `content-assets`: the archive, its materialization, and its failure now cover a third tree. The name of the first requirement changes with it.
- `harness-runtime`: the composition root gains one realization, the lookup that maps a manifest specifier onto the materialized file.

## Impact

- `scripts/build.ts` — the asset entries of the archive, and the refusal.
- `src/modules/harness/content.ts` — the third materialized directory.
- `src/modules/harness/runtime.ts` — the binding at the composition root.

## A note on the dependency direction

The three packages that hold the assets are dependencies of the harness, and not of the CLI. Thus the build resolves each specifier through the installation of the harness, and never through its own. The CLI adds no dependency for this work.
