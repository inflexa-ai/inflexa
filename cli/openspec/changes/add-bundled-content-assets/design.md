## Context

`skillsDir` and `templatesDir` are harness config the CLI supplies at its composition root. Both point at real directory trees the **harness host process** reads with `node:fs` (`readdir`+`readFile` in `harness/src/tools/sandbox/skills.ts`; Nunjucks `FileSystemLoader` in `harness/src/execution/report-render.ts`). Nothing is mounted into the sandbox container and nothing is downloaded at runtime — the trees just have to exist on the host.

`cli/src/modules/harness/config.ts` resolves them:

```ts
skillsDir:    cfg?.skillsDir    ?? (env.isDevelopment ? devSkillsDir    : null),
templatesDir: cfg?.templatesDir ?? (env.isDevelopment ? devTemplatesDir : null),
```

`devSkillsDir`/`devTemplatesDir` walk `import.meta.dir` up to the repo root — valid only in a checkout. In a compiled binary `import.meta.dir` is a bundled virtual path, so production falls to `null`, and `runtime.ts:389`/`:396` reject boot with `skills_dir_missing`/`templates_dir_missing`. An installed OSS user therefore cannot run an analysis without hand-pointing config at a checkout.

The CLI stores machine state under **XDG base dirs** namespaced by `inflexa/` (`cli/src/lib/env.ts`): materialized/downloaded assets — `agent.db`, `refs/`, `models/`, `postgres/` — live under the **data dir** (`~/.local/share/inflexa/` · `%LOCALAPPDATA%\inflexa\`); settings (`config.json`, `auth.json`) under the **config dir**. Extracted skills/templates are a materialized asset, so they belong under the data dir beside `refs/` and `models/`, not near config. (`env.ts:137` already documents that skills+templates dirs are repointed at the checkout in dev and must not be by the `INFLEXA_DEV=1` support escape hatch — the skills/templates-dir resolution is already an env-aware concern.)

## Goals / Non-Goals

**Goals:**
- One artifact: a `curl | bash` install yields a fully working, offline-capable binary — skills and templates included, verified for free as part of the binary's own `SHA256SUMS`/attestation.
- Content materializes automatically on first run to a real, hash-keyed directory tree the harness can `readdir`.
- A new binary version updates the on-disk content automatically (new content → new hash → fresh extract), with no separate download and no version-compat matrix.
- The harness is untouched; this is purely embedder-side build + composition-root wiring.

**Non-Goals:**
- No out-of-band content update channel decoupled from the binary (a future `inflexa content update` could layer a newer bundle over the same hash-dir seam — explicitly deferred; the hash-dir indirection keeps that door open).
- No change to how the harness reads skills/templates, and no change to `install.sh`.
- No independent release cadence for content — content ships with (and is versioned by) the binary. This is largely a feature: `templates/` and the `report-html` skill's `design-system.md` are "two halves of one feature," and skills quote package APIs that must match the sandbox image — so content correctness is entangled with the code, and a single atomically-consistent unit is the safer default.

## Decisions

### Embed one combined `content.tar`, extract to a hash-keyed data-dir directory
The build tars `skills/`+`templates/` into a single archive and embeds it. On a release boot the archive is extracted to `join(env.contentDir, contentHash, {"skills","templates"})`, and `skillsDir`/`templatesDir` default there. One tarball (not two) because independent update of skills vs templates is a non-goal — updates ride the binary regardless — so the extra seam earns nothing. `env.contentDir = join(dataDir(), "inflexa", "content")`, a peer of `env.refsDir`/`env.modelDir`.

### Keyed by a deterministic content hash, not by version or git commit
The directory name is a hash **over the file set** (sorted `path` + `sha256(bytes)` pairs), independent of tar mtime/ownership, baked via `--define` like `gitCommit`. Consequences that satisfy the "update on new install" requirement directly:
- A new binary whose content changed → new hash → `existsSync` miss → fresh extract → resolves to the new tree. Update is automatic and needs no "is my copy stale?" comparison.
- A binary whose content is byte-identical to a prior one reuses the existing dir — no redundant re-extract on a version bump that didn't touch content.
- Content edits always propagate (edited bytes → new hash), even across a same-version rebuild.

Rejected: keying by `gitCommit` (re-extracts on every commit even when content is unchanged) or by release version (misses content-only edits and couples to the tag scheme).

### Extraction is atomic and idempotent; separated from path-defaulting
`config.ts` only **computes the default path** (pure, no IO), mirroring how `refsDir` is a computed path whose presence is a separate concern. Materialization is a deliberate boot step `ensureBundledContent()` (new `src/modules/harness/content.ts`), run in a release build before the skills/templates pre-flight gate:
1. If `join(contentDir, hash, "skills")` and `.../templates` already exist → done (idempotent; the common warm path does no work).
2. Else extract the embedded archive into a temp dir under `contentDir` (`.tmp-<hash>-<pid>`), then `rename` it onto `contentDir/<hash>`. The rename is the atomic commit — a partially-extracted tree is never visible under the final name, and a concurrent process that lost the rename race discards its temp copy. Mirrors `install.sh`'s staged-then-rename install.
3. Returns `Result<{ skillsDir, templatesDir }, ContentError>`; a failure (unwritable data dir, corrupt archive, rename collision that isn't an already-present dir) fails boot with a remedy, never a fake success — consistent with the harness-runtime rule that no locally-unrealizable capability is faked.

### Stale hash dirs are pruned best-effort
After the current hash is ensured, sibling `content/*` dirs whose name is neither `contentHash` nor a live `.tmp-*` are removed best-effort; failures are non-fatal and never block boot. Kept simple because each tree is ~1.6 MB. An older binary still running against its own hash dir is the reason pruning is best-effort and non-fatal rather than a hard sweep.

### Dev is unchanged
`env.isDevelopment` keeps resolving `skillsDir`/`templatesDir` to the repo-root trees via `import.meta.dir`; `ensureBundledContent()` is a no-op (never called) in dev, and no archive is embedded or extracted. The `INFLEXA_DEV=1` support escape hatch must **not** flip content resolution to the checkout (per the existing `env.ts:137` note) — content resolution keys off the build channel, not the dev-commands toggle.

## Risks / Trade-offs

- **[Load-bearing: Bun `--compile` must actually embed the archive]** → The exact embed mechanism (a static `import archive from "./content.tar" with { type: "file" }` in `content.ts`, vs adding the tar as a dedicated Bun.build asset entrypoint the way the parser.worker is added in `build.ts`) must be **confirmed against the installed Bun before relying on it**, since a static top-level asset import would also have to resolve during `bun run dev` (where the tar is absent). Likely resolution: gate the load behind the release channel via a statically-analyzable dynamic `import()`, or add the tar as a second Bun.build entrypoint and read its baked `/$bunfs` path — both keep dev from needing the file. Fallback: a generated bytes module. Validate first (as `add-workspace-context` validated its store-snapshot assumption) — this is the one thing to nail down at the start of implementation.
- **[Unwritable data dir]** → `ensureBundledContent()` fails boot with a clear "could not materialize bundled content at <path>" message naming the remedy, rather than the misleading downstream `skills_dir_missing`.
- **[Content coupled to binary release]** → Accepted, and mostly desirable (see Non-Goals). The hash-dir seam preserves a future out-of-band update path if decoupling is ever actually wanted.
- **[Pruning a dir an older instance is reading]** → Pruning is best-effort/non-fatal and only touches non-current hashes; the window is a boot-time gate plus on-demand skill reads. Acceptable; a keep-most-recent policy is a trivial future tightening if it ever bites.
- **[Binary size +~1.6 MB]** → Negligible against the embedded Bun runtime.

## Migration Plan

No runtime data migration. First run of a build carrying this change extracts content into a new `contentDir/<hash>` tree; nothing pre-existing is read or moved. Rollback is reverting the change set — an older binary simply falls back to its prior resolution (dev: repo root; release: the prior `null`/gate behavior). Verifiable by: `bun run build` produces a binary whose `--version` smoke test passes and which, run with an empty data dir and no `config.json` override, boots and resolves `skillsDir`/`templatesDir` to a populated `contentDir/<hash>` tree.

## Open Questions

- None blocking. The Bun embed-mechanism check above is the one item to confirm before implementation. `INFLEXA_CONTENT_HASH` naming and whether it lives in the `bakedEnv` block or as a standalone `--define` (like `INFLEXA_GIT_COMMIT`, whose requirement is channel-conditional) is an implementation detail settled during apply.
