## Why

The harness reads skills and templates as plain content off the host filesystem — `skill_search`/`skill_read` `readdir`+`readFile` the tree (`harness/src/tools/sandbox/skills.ts`), and report rendering points a Nunjucks `FileSystemLoader` at it (`harness/src/execution/report-render.ts`). The CLI supplies those two paths via `skillsDir`/`templatesDir`. Today the production default is **`null`** (`cli/src/modules/harness/config.ts:173`): `import.meta.dir` walks up to the repo-root `skills/`/`templates/` only in a dev checkout, and is "meaningless inside a compiled binary." Boot then gates on it (`runtime.ts:389` → `skills_dir_missing` / `templates_dir_missing`).

So a user who runs `curl -fsSL https://inflexa.ai/install.sh | bash` gets a binary that **cannot run an analysis** unless they hand-edit `config.json` to point at a git checkout. There is no env-var fallback and no bundled directory. We want the content to arrive with the binary — one artifact, effortless for us and for them — rather than as a separate, user-initiated download like sandbox images (`inflexa sandbox pull`). The content is tiny (skills 1.5 MB / 117 files, templates 72 KB / 11 files) against a ~50–100 MB Bun binary, so embedding is free. The reads use `readdir` over a directory tree, which a Bun `/$bunfs` embedded asset cannot satisfy — so the content must land as a **real directory tree on disk**; the only question is where the bytes come from, and here they come from the binary itself.

## What Changes

- **Build embeds the content.** `cli/scripts/build.ts` tars the repo-root `skills/` + `templates/` into one `content.tar`, embeds it into every compiled target, and bakes a deterministic **content hash** (over the file set, independent of tar mtime/ownership) as a compile-time constant, alongside `gitCommit`.
- **First run materializes it.** In a release build, boot extracts the embedded archive — before the skills/templates pre-flight gate — to `<dataDir>/inflexa/content/<contentHash>/{skills,templates}` if not already present, atomically (extract to a temp dir, then `rename`). `skillsDir`/`templatesDir` default to that directory. This makes the content a materialized data asset, a peer of the existing `refs/` and `models/` under the data dir — not config.
- **New install updates the content.** The directory is keyed by content hash, so a new binary version (whose embedded content differs) resolves to a new hash dir and extracts a fresh tree on first run; stale hash dirs are pruned best-effort. Updates ride the binary — no separate step, no version-negotiation matrix.
- **Dev is unchanged.** A development run still resolves `skillsDir`/`templatesDir` to the repo-root trees via `import.meta.dir`; it never embeds or extracts.
- **`env.contentDir`** is added to the `env` path registry, next to `refsDir`/`modelDir`.

## Capabilities

### New Capabilities
- `content-assets`: the build-time embedding of `skills/`+`templates/` into the release binary, the deterministic content hash, first-run extraction to the hash-keyed data-dir location, automatic re-extraction on a new binary version, stale-dir pruning, and the release-vs-dev resolution of `skillsDir`/`templatesDir`. Its boundary: it materializes content and hands boot two directory paths — it does not change how the harness *reads* skills/templates.

### Modified Capabilities
- `harness-runtime`: the "Local realizations for every conversation dependency" requirement's `skillsDir`/`templatesDir` default changes — absent a config override, they resolve to the extracted content directory in a **release build** and to the repo-root trees in a **development run**, rather than "the repository root's `templates/` directory" unconditionally. The pre-flight existence gate is unchanged; it now passes because `content-assets` materialized the tree first.

## Impact

- **Build:** `cli/scripts/build.ts` — generate `content.tar` from `../skills` + `../templates`, compute + `--define` the content hash, embed the archive.
- **New file:** `cli/src/modules/harness/content.ts` — `ensureBundledContent()` (extract-if-absent, atomic, prune stale) returning `Result`, plus the embedded-archive reference.
- **Modified:** `cli/src/lib/env.ts` (add `contentDir`; bake `contentHash`), `cli/src/modules/harness/config.ts` (production default of `skillsDir`/`templatesDir` → `join(env.contentDir, contentHash, …)`), `cli/src/modules/harness/runtime.ts` (call `ensureBundledContent()` in a release build before the skills/templates gate; map its error to a clear boot failure).
- **No new dependency**; extraction uses Bun/Node tar facilities already available. **No harness change** — the harness still just consumes two paths.
- **Verification hazard:** whether Bun `--compile` embeds the archive via the intended mechanism (static `with { type: "file" }` vs a dedicated asset entrypoint, like the parser.worker) must be confirmed against the installed Bun **before** relying on it — see design. The installer (`install.sh`) is untouched.
