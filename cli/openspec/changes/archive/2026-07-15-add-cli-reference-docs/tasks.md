# Tasks: add-cli-reference-docs

## 1. Registry argument descriptions

- [x] 1.1 Convert every inline positional declaration in `src/cli/index.ts` to `.command("<name>")` + `.argument(name, description)` calls with non-empty descriptions (`new`, `resume`, `open`, `analysis set-project`, `project new`, `prov export`, `prov lineage`, `prov verify`, `prov verify-file`, `repair`, `relocate`, `prune` args, `refs download`, `refs verify`, `sandbox pull`, dev-channel `run`/`chat`), preserving the exact user-visible syntax (`[x]`, `<x>`, variadic `...`)
- [x] 1.2 Verify no behavior change: `bun run typecheck`, `bun test` (registry tests `src/cli/cli.test.ts`, `src/cli/read_commands.test.ts`), and spot-check `bun run dev -- new --help` shows argument descriptions

## 2. Generator script

- [x] 2.1 Write `scripts/gen_docs.ts`: refuse to run when `NODE_ENV=test` (before importing the registry), delete `INFLEXA_DEV` from the environment, then dynamically import `{ cli }` from `src/cli/index.ts` and `{ envDoc }` from `src/lib/env.ts`
- [x] 2.2 Implement the tree walk: per visible command emit title/description frontmatter, usage line, argument table, option table (flags, description, declared default), subcommand index with relative links; skip hidden options and the implicit `help` command; fail non-zero naming the command when a visible argument/option has an empty description
- [x] 2.3 Implement the portability layer: code-span every flag/usage/argument token, escape `<` and `{{` in description prose, no admonitions/MDX/HTML blocks, no timestamps (byte-deterministic output)
- [x] 2.4 Emit the environment page (`environment.md`) from `envDoc`: Paths table and Environment table, including the base-var override rows
- [x] 2.5 Emit the publishable package to `dist-docs/` (directory-per-group layout with `index.md` per group, relative links) plus `manifest.json` (`schemaVersion: 1`, `cliVersion` from `package.json`, `name`, `nav` tree in registry declaration order covering every page exactly once)
- [x] 2.6 Add `docs:gen` to `package.json` scripts and add `dist-docs/` to the ignore file; run `bun run format:file scripts/gen_docs.ts` per the formatting convention

## 3. Generated output

- [x] 3.1 Run `bun run docs:gen`, review `dist-docs/` for rendering correctness (tables, code spans, links, manifest nav coverage)
- [x] 3.2 Verify determinism: run generation twice, assert byte-identical outputs; verify dev-channel exclusion by running with `INFLEXA_DEV=1` exported and confirming no `profile`/`run`/`chat` pages or nav entries
- [x] 3.3 Validate portability: run the emitted package markdown through a scratch VitePress 1.x build (outside the repo, throwaway) to confirm no page fails Vue-template compilation

## 4. CI generation check

- [x] 4.1 Add a step to the cli lint job in the repo CI workflow that runs `bun run docs:gen` and fails the job on non-zero exit
- [x] 4.2 Confirm the check catches breakage (locally simulate: blank an argument description, run the generator, see it fail naming the command; revert)

## 5. Release asset

- [x] 5.1 Add a step to `.github/workflows/release.yml` after release creation: `bun install` + `bun run docs:gen` in `cli/`, tar `dist-docs/` contents as `cli-docs.tar.gz` (manifest at archive root), `gh release upload` to the version's release
- [x] 5.2 Verify the workflow change: actionlint (or careful review against the existing steps' conventions — pinned actions, permissions, idempotent re-run via `--clobber`)

## 6. Documentation

- [x] 6.1 Document the generator in `cli/CLAUDE.md`'s or `docs/` conventions where appropriate: `docs:gen` emits the publishable package to `dist-docs/` (untracked), never run the generator under `bun test` (env.ts data-loss guard), dev channel excluded by design
- [x] 6.2 Record the consumer contract pointer: the manifest schema lives in the `cli-reference-docs` spec; atrium fetches `releases/latest/download/cli-docs.tar.gz`
