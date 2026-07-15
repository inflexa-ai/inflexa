# Design: CLI Reference Docs Generation and Publishing

## Context

The commander registry (`src/cli/index.ts`) exports the configured `cli` Command without calling `.parse()`; `src/index.ts` is the only parse site. Every command action is lazy-imported, so importing the registry evaluates only commander, `package.json`, and `src/lib/env.ts` — verified: `bun -e 'import("./src/cli/index.ts")'` loads cleanly and reports the full tree. Commander v15's public introspection surface (`.commands`, `.options`, `.registeredArguments`, `.name()`, `.description()`) exposes everything the docs need; there is no built-in JSON/Markdown export.

The Paths/Environment appendix on root `--help` is not free text — it renders from the structured `envDoc` table in `src/lib/env.ts`, which the generator can consume directly.

The consumer is the atrium website (separate repo, Vite + React, no markdown pipeline of its own). It will run a docs SSG (VitePress 1.x recommended) over content fetched from this repo's GitHub releases. The contract must not assume any particular SSG.

The repo-level `release.yml` already cuts an attested GitHub Release on every `cli/package.json` version bump; the repo is public, so release assets have stable unauthenticated URLs (`releases/latest/download/<file>`).

## Goals / Non-Goals

**Goals:**

- One generator, one source of truth: the commander registry + `envDoc`. No hand-maintained command docs anywhere.
- A single output: the publishable SSG-neutral package (markdown + `manifest.json`) in an untracked build directory. Nothing generated is committed to git.
- Docs describe exactly the release binary: dev-channel commands never appear.
- Zero new dependencies in `cli/`.
- A registry change that breaks generation fails CI on the PR, not first at release time.

**Non-Goals:**

- Website-side rendering (VitePress config, sync script, styling) — lives in the atrium repo.
- Man pages, `--help`-text capture, or prose guides/tutorials — this is reference generation only.
- A JSON export of the command tree for programmatic consumers other than the nav manifest.
- Documenting hidden options or the dev channel.

## Decisions

### D1: DIY introspection script over existing packages

The only dedicated commander→markdown packages (`commander-to-markdown`, `@mitsuru793/commander-document-generator`) are unmaintained (9 and 6 years), predate the modern API, and don't handle nested subcommands. Commander's public properties make the walk trivial. A `scripts/gen_docs.ts` beside `build.ts`/`wipe.ts` follows the existing scripts convention and adds no dependency (the `cli/` CLAUDE.md forbids new deps without approval).

### D2: Import the registry, not the entry point; never under `bun test`

The generator imports `{ cli }` from `src/cli/index.ts` — not `src/index.ts`, which wires telemetry/logging/provenance and parses argv. It never invokes actions, so lazy imports keep the TUI/DB/harness out of the process.

**Load-bearing caveat**: `src/lib/env.ts` (imported by the registry) has a module-evaluation data-loss guard that throws when `NODE_ENV=test` without `INFLEXA_TEST_SANDBOX`, to keep test processes away from real user data. The generator therefore runs only as a plain `bun scripts/gen_docs.ts` process. No test may import `scripts/gen_docs.ts`; the CI generation check runs the script as a subprocess, not as a test.

### D3: Dev channel excluded at generation time

`profile`/`run`/`chat` register only when `devCommandsEnabled()` (`src/cli/index.ts:137`), which is `isDevelopmentBuild(INFLEXA_BUILD_CHANNEL) || INFLEXA_DEV === "1"` — true for ANY non-production channel, including the unset channel of a plain source run. Deleting `INFLEXA_DEV` alone is therefore not enough: the generator bakes `process.env.INFLEXA_BUILD_CHANNEL = "production"` AND deletes `INFLEXA_DEV` before dynamically importing the registry (dynamic, because static imports would hoist past the mutations). Exclusion then happens through the exact gate that shapes a shipped binary — no filtering logic, no second list to maintain. Faking the channel is sound in this import-only process: the registry import path reads the channel solely through that gate (`bakedEnv.gitCommit` would throw under a production channel, but it is a lazy getter nothing in generation reads).

### D4: Portable CommonMark + manifest, not SSG-native output

Alternatives considered:

- **Atrium-native output** (JS data module / JSX / pre-rendered HTML): rejected — couples this repo to the website's framework and design; the website owner explicitly declined.
- **SSG-specific markdown** (MkDocs nav YAML, VitePress sidebar file, Starlight frontmatter): rejected — picks the website's tooling for it.
- **Chosen**: CommonMark-only pages with frontmatter limited to `title` + `description` (the subset every candidate SSG reads), plus `manifest.json` carrying the ordered nav tree. Nav is the one thing SSGs disagree on; shipping it as data means the consumer writes ~15 lines of glue mapping manifest → its sidebar format, and switching SSGs later never changes this contract.

Portability rules enforced by the generator (not by convention):

- Every machine-emitted token that can contain angle brackets — flags (`--analysis <id|name>`), usage lines, argument names — is wrapped in code spans or fenced blocks. Raw `<...>` is parsed as an HTML tag by VitePress (markdown compiles through Vue templates) and by Python-Markdown.
- No admonitions, no `{{ }}`, no MDX/JSX, no HTML blocks.
- Descriptions come from the registry verbatim; they are authored prose and must stay CommonMark-safe (the generator escapes stray `<`/`{{` in them defensively rather than trusting authors).

### D5: Package layout mirrors the command tree; manifest is the structure channel

```
cli-docs.tar.gz
├── manifest.json
├── index.md                 # root command: usage, global options, subcommand index
├── new.md, ls.md, resume.md, open.md, status.md, repair.md, relocate.md, prune.md, up.md, down.md, setup.md
├── analysis/index.md, analysis/set-project.md
├── project/index.md, project/new.md, project/ls.md
├── prov/index.md, prov/export.md, prov/lineage.md, prov/verify.md, prov/verify-file.md
├── auth/index.md, auth/login.md, auth/logout.md, auth/whoami.md
├── refs/index.md, refs/list.md, refs/download.md, refs/verify.md, refs/path.md
├── sandbox/index.md, sandbox/pull.md, sandbox/status.md
├── config.md, sessions.md
└── environment.md            # Paths + Environment tables from envDoc
```

`manifest.json` schema (v1):

```json
{
  "schemaVersion": 1,
  "cliVersion": "<package.json version>",
  "name": "inflexa",
  "nav": [
    { "title": "inflexa", "path": "index.md" },
    { "title": "new", "path": "new.md" },
    { "title": "prov", "path": "prov/index.md", "items": [
      { "title": "prov export", "path": "prov/export.md" }
    ] },
    { "title": "Environment", "path": "environment.md" }
  ]
}
```

`schemaVersion` is the compatibility handle: consumers hard-fail on a major they don't know. Nav order is registration order (the registry's declaration order is the curated order; no alphabetical resorting). No timestamps in the package — output must be byte-identical for the same registry, so the release-time regeneration provably reproduces what CI verified (D9).

### D6: Single output — the publishable package; nothing generated is committed

The generator writes only the package, to the untracked `dist-docs/`. A committed developer reference (`docs/reference/`) was considered and dropped (owner decision): in-repo readers already have `--help` from source, committing generated files invites merge noise, and it would require a diff-based drift check to keep honest. With a single untracked output, there is exactly one layout, one materialization path, and no committed artifact that can go stale.

Consequence: CI cannot diff anything — instead it verifies generation *succeeds* (D8), which is also what enforces the non-empty-description invariant (D7) on every PR.

### D7: Argument descriptions move to `.argument()` declarations

`registeredArguments` currently carry empty descriptions because positionals are declared inline in the command string (`cli.command("new [name] [paths...]")`). Each registration converts to `.command("new")` + `.argument("[name]", "…")` + `.argument("[paths...]", "…")`. Commander treats both forms identically for parsing — the user-visible syntax and the spec-pinned registration strings (`inflexa new [name] [paths...]`) are unchanged — while `--help` and the generated docs gain per-argument descriptions. The generator fails (non-zero) on any visible argument or option with an empty description, making completeness a build-enforced invariant rather than a review nicety.

### D8: CI runs the generator as a validity gate

The existing repo CI (lint job for `cli`) runs `bun run docs:gen` as a subprocess on every PR. There is nothing to diff (D6); the gate is that generation exits 0 — which fails loudly on an argument/option registered without a description (D7), a registry that stops being importable standalone, or emitted output that violates the generator's own portability assertions. It lives beside ESLint because it is the same category: a source-validity check.

### D9: Release asset step is additive to release.yml

After the existing release-creation step, the workflow runs the generator at the release's source revision (the only materialization — the package is untracked), tars `dist-docs/` as `cli-docs.tar.gz`, and `gh release upload`s it. Because generation is deterministic (D4) and CI ran the same generator on the same commit (D8), the asset matches what CI verified. Consumers use `releases/latest/download/cli-docs.tar.gz` (or a pinned `v<version>` URL); `manifest.json`'s `cliVersion` lets them display what they're rendering.

### D10: Deterministic environment-page paths via placeholder base vars

`renderEnvHelp` prints `env[key]` — absolute paths resolved from the generating machine's home directory, which would break byte-determinism. Instead of dropping the location column, the generator seeds the base vars with their own names as literal placeholders (`XDG_DATA_HOME="$XDG_DATA_HOME"`, `XDG_CONFIG_HOME="$XDG_CONFIG_HOME"`) before importing `env.ts`; `dataDir()`/`configDir()` return an env override verbatim, so `env.dbPath` comes out as `$XDG_DATA_HOME/inflexa/agent.db` — machine-independent and self-documenting. A static prose line documents the unset-var defaults (`~/.local/share`, `~/.config`). Because `dataVar`/`configVar` are themselves platform-dependent (`LOCALAPPDATA` on Windows) and joins use the platform separator, the generator refuses to run on win32 — determinism is a contract property, not a nicety.

## Risks / Trade-offs

- [Registry import gains side effects later] → The generator's process is import-only by design; if a future registry import wires runtime state, generation breaks loudly (it runs in CI on every PR via the generation check), not silently.
- [`env.ts` guard trips in an unexpected environment] → The generator asserts early that it is not running under `bun test` (checks `NODE_ENV !== "test"`) and documents the plain-`bun` invocation in the script header; the CI generation check invokes it as a subprocess.
- [Descriptions contain markdown-hostile text] → Generator escapes `<` and `{{` in prose fields defensively (D4); flags/usage are always code-spanned, so the main vector is closed structurally.
- [Nav manifest and files disagree] → Both are emitted from the same in-memory walk in one pass; there is no second traversal to diverge.
- [Consumer breaks on schema evolution] → `schemaVersion` bumps on breaking manifest changes; additive fields don't bump. The contract is documented in the spec, which is the reference for the atrium-side glue.
- [Release asset differs from what CI saw] → Generation is deterministic (no timestamps, no environment-dependent strings), so regenerating at the tagged commit reproduces byte-identical content to CI's run on that commit; a commander upgrade that changes introspected values changes the content at the PR where the upgrade lands, where CI's generation run exercises it.

## Migration Plan

Purely additive: new script, one new CI step, one new release step. No rollback concerns — removing the asset step or the generation check reverts cleanly. The atrium-side consumption starts only after the first release that carries the asset.

## Open Questions

- None blocking. (Whether atrium commits the synced markdown or fetches at build time is an atrium-repo decision and does not affect this contract.)
